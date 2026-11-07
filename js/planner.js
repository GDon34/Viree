// Générateur de parcours « découverte ».
// Principe : on fabrique des parcours candidats (boucles en pétale ou détours),
// on les fait calculer par Valhalla, on les note, et on garde les meilleurs.
import {
  haversine, bearing, destination, angleDiff, resample, bbox, rng, hashString, cellKey,
  nearestOnLine,
} from './geo.js';
import { route, overpass, elementPoint, RouteError, AbortedError } from './services.js';
import { fetchStopPois, placeStops } from './stops.js';
import { nameRoutes } from './names.js';

// --- Règles de durée ---------------------------------------------------------

// Trajet A→B : 0 % = le plus rapide, 50 % = milieu entre durée souhaitée et durée max,
// 100 % = durée max. Interpolation linéaire entre ces repères.
export function abTargetMinutes(fastMin, wishMin, maxMin, d) {
  const max = Math.max(maxMin, fastMin);
  const wish = Math.min(Math.max(wishMin, fastMin), max);
  const mid = (wish + max) / 2;
  if (d <= 0.5) return fastMin + (mid - fastMin) * (d / 0.5);
  return mid + (max - mid) * ((d - 0.5) / 0.5);
}

// --- Points d'intérêt « découverte » ----------------------------------------

const INTEREST_WEIGHTS = { pass: 3, viewpoint: 2, lake: 2, waterfall: 1.5, castle: 1.5 };

function interestQuery(area) {
  const f = area.type === 'around'
    ? `(around:${Math.round(area.radius)},${area.center[0].toFixed(5)},${area.center[1].toFixed(5)})`
    : `(${area.bbox.s.toFixed(4)},${area.bbox.w.toFixed(4)},${area.bbox.n.toFixed(4)},${area.bbox.e.toFixed(4)})`;
  return `[out:json][timeout:30];(
node["tourism"="viewpoint"]${f};
node["mountain_pass"="yes"]${f};
node["natural"="saddle"]["name"]${f};
way["natural"="water"]["water"~"^(lake|reservoir)$"]["name"]${f};
relation["natural"="water"]["water"~"^(lake|reservoir)$"]["name"]${f};
node["waterway"="waterfall"]${f};
node["historic"~"^(castle|ruins|monastery|fort)$"]["name"]${f};
way["historic"~"^(castle|fort)$"]["name"]${f};
);out center tags;`;
}

export function classifyInterest(el) {
  const t = el.tags || {};
  const point = elementPoint(el);
  if (!point) return null;
  let kind = null;
  if (t.mountain_pass === 'yes' || t.natural === 'saddle') kind = 'pass';
  else if (t.tourism === 'viewpoint') kind = 'viewpoint';
  else if (t.natural === 'water') kind = 'lake';
  else if (t.waterway === 'waterfall') kind = 'waterfall';
  else if (t.historic) kind = 'castle';
  if (!kind) return null;
  const ele = parseFloat(String(t.ele || '').replace(',', '.'));
  return {
    id: el.type + el.id,
    kind,
    name: t['name:fr'] || t.name || '',
    point,
    weight: INTEREST_WEIGHTS[kind] + (t.name ? 0.3 : 0),
    ele: Number.isFinite(ele) ? Math.round(ele) : null,
  };
}

async function fetchInterest(area, signal) {
  try {
    const els = await overpass(interestQuery(area), { signal });
    return els.map(classifyInterest).filter(Boolean);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    return []; // sans points d'intérêt, on se contente des virages
  }
}

// --- Fabrication des candidats ----------------------------------------------

const WAYPOINT_FILTER = { min_road_class: 'unclassified', max_road_class: 'primary' };

const LOOP_BEARINGS = [0, 180, 90, 270, 45, 225, 135, 315, 22, 202, 112, 292];

function snapToPoi(pt, pois, radius, used) {
  let best = null, bestScore = 0;
  for (const p of pois) {
    if (used.has(p.id)) continue;
    const d = haversine(pt, p.point);
    if (d > radius) continue;
    const s = p.weight / (1 + d / (radius * 0.5));
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best) used.add(best.id);
  return best;
}

export function loopCandidate(i, start, targetS, d, pois, scale, rand) {
  const speed = 14.4 * (1 - 0.15 * d); // m/s (≈ 52 km/h, moins sur routes sinueuses)
  const L = targetS * speed;
  const P = L / 1.35;
  const n = targetS < 5400 ? 2 : targetS < 12600 ? 3 : 4;
  const k = n + 1;
  const polyFactor = Math.sin(Math.PI / k) / (Math.PI / k);
  const r = (P / (2 * Math.PI * polyFactor)) * scale;
  const theta = (LOOP_BEARINGS[i % LOOP_BEARINGS.length] + (rand() - 0.5) * 30 + 360) % 360;
  const snap = d < 0.25 ? i % 3 === 2 : d > 0.6 ? i % 3 !== 0 : i % 2 === 1;
  const dir = i % 4 < 2 ? 1 : -1;
  const center = destination(start, theta, r);
  const startAngle = (theta + 180) % 360;
  const used = new Set();
  const waypoints = [];
  for (let j = 1; j <= n; j++) {
    const ang = startAngle + dir * (j * 360 / k + (rand() - 0.5) * 16);
    let pt = destination(center, ang, r * (0.92 + rand() * 0.16));
    if (snap) {
      const p = snapToPoi(pt, pois, r * 0.45, used);
      if (p) pt = p.point;
    }
    waypoints.push(pt);
  }
  return { waypoints, snap, key: 'L' + i };
}

const AB_TEMPLATES = [
  { fr: [0.5], side: [-1] },
  { fr: [0.5], side: [1] },
  { fr: [0.3, 0.7], side: [-1, -1] },
  { fr: [0.3, 0.7], side: [1, 1] },
  { fr: [0.33, 0.66], side: [-1, 1] },
  { fr: [0.33, 0.66], side: [1, -1] },
  { fr: [0.25], side: [-1] },
  { fr: [0.75], side: [1] },
  { fr: [0.75], side: [-1] },
  { fr: [0.25], side: [1] },
];

function abPoints(A, B, tpl, h) {
  const D = haversine(A, B), brg = bearing(A, B);
  return tpl.fr.map((f, j) => {
    const base = destination(A, brg, f * D);
    return destination(base, brg + 90 * tpl.side[j], h);
  });
}

function straightLen(A, pts, B) {
  let s = 0, prev = A;
  for (const p of pts) { s += haversine(prev, p); prev = p; }
  return s + haversine(prev, B);
}

export function abCandidate(i, A, B, straightTarget, d, pois, rand) {
  const tpl = AB_TEMPLATES[i % AB_TEMPLATES.length];
  const D = haversine(A, B);
  if (straightTarget <= D * 1.02) return null;
  let lo = 0, hi = Math.max(D, straightTarget);
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (straightLen(A, abPoints(A, B, tpl, mid), B) < straightTarget) lo = mid; else hi = mid;
  }
  const h = (lo + hi) / 2 * (0.9 + rand() * 0.2);
  let waypoints = abPoints(A, B, tpl, h);
  const snap = d > 0.3 ? i >= AB_TEMPLATES.length / 2 || i % 2 === 1 : i % 3 === 2;
  if (snap) {
    const used = new Set();
    waypoints = waypoints.map((pt) => {
      const p = snapToPoi(pt, pois, Math.max(3000, h * 0.5), used);
      return p ? p.point : pt;
    });
  }
  return { waypoints, snap, key: 'AB' + i };
}

// --- Analyse d'un parcours ---------------------------------------------------

export function analyzeRoute(r, interestPois, mode) {
  const step = 20;
  const pts = resample(r.shape, r.cum, step);
  const km = r.totalM / 1000;
  // Masque autour des carrefours : un virage à angle droit en ville n'est pas un « virage » plaisir.
  const mask = new Uint8Array(pts.length);
  for (const m of r.maneuvers) {
    if (!m.isTurn) continue;
    const c = Math.round(m.along / step);
    for (let j = c - 2; j <= c + 2; j++) if (j >= 0 && j < mask.length) mask[j] = 1;
  }
  let turnSum = 0;
  let prevH = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const h = bearing(pts[i], pts[i + 1]);
    if (prevH !== null && !mask[i]) {
      const dlt = Math.abs(angleDiff(prevH, h));
      if (dlt >= 1.5 && dlt <= 100) turnSum += dlt;
    }
    prevH = h;
  }
  const degPerKm = km > 0 ? turnSum / km : 0;

  // Portions parcourues deux fois (allers-retours sur la même route).
  const seen = new Map();
  let retraced = 0, counted = 0;
  const edge = 2000;
  for (let i = 0; i < pts.length; i += 2) {
    const along = i * step;
    const key = cellKey(pts[i], 60);
    const first = seen.get(key);
    const inEnds = mode === 'loop' && (along < edge || along > r.totalM - edge);
    if (!inEnds) counted++;
    if (first === undefined) seen.set(key, along);
    else if (along - first > 1500 && !inEnds) retraced++;
  }
  const overlap = counted ? retraced / counted : 0;

  // Points d'intérêt longés.
  const grid = new Map();
  const coarse = [];
  for (let i = 0; i < pts.length; i += 5) coarse.push({ p: pts[i], along: i * step });
  for (const c of coarse) {
    const k = cellKey(c.p, 1000);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  const near = (p, maxD) => {
    const [cx, cy] = cellKey(p, 1000).split(':').map(Number);
    let best = null;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
      const list = grid.get((cx + dx) + ':' + (cy + dy));
      if (!list) continue;
      for (const c of list) {
        const dd = haversine(p, c.p);
        if (dd <= maxD && (!best || dd < best.dist)) best = { dist: dd, along: c.along };
      }
    }
    return best;
  };
  const sights = [];
  for (const poi of interestPois) {
    const maxD = poi.kind === 'lake' ? 1500 : poi.kind === 'pass' ? 200 : 350;
    const hit = near(poi.point, maxD);
    if (hit) sights.push({ ...poi, along: hit.along, dist: hit.dist });
  }
  // On ne compte qu'une fois les points d'intérêt très proches les uns des autres.
  sights.sort((a, b) => a.along - b.along);
  const distinct = [];
  for (const s of sights) {
    const dup = distinct.find((o) => o.kind === s.kind && Math.abs(o.along - s.along) < 800);
    if (dup) { if (s.weight > dup.weight) Object.assign(dup, s); } else distinct.push(s);
  }
  const panoramaScore = distinct.reduce((a, s) => a + s.weight, 0);
  const turns = r.maneuvers.filter((m) => m.isTurn).length;
  const manDensity = km > 0 ? turns / (km / 10) : 0;
  const passes = distinct.filter((s) => s.kind === 'pass');
  const highest = passes.filter((p) => p.ele).sort((a, b) => b.ele - a.ele)[0] || null;

  return {
    degPerKm,
    curvRating: degPerKm < 30 ? 1 : degPerKm < 60 ? 2 : degPerKm < 100 ? 3 : degPerKm < 160 ? 4 : 5,
    overlap,
    sights: distinct,
    panoramaScore,
    panoramaCount: distinct.filter((s) => s.kind !== 'lake').length + distinct.filter((s) => s.kind === 'lake').length,
    lakes: distinct.filter((s) => s.kind === 'lake'),
    manDensity,
    highest,
  };
}

export function scoreRoute(m, r, ctx) {
  const d = ctx.discovery;
  const curvN = Math.min(1, m.degPerKm / 160);
  const panoN = Math.min(1, m.panoramaScore / 8);
  const manN = Math.min(1, m.manDensity / 8);
  const fun = 0.6 * curvN + 0.4 * panoN;
  const calm = 1 - manN;
  let s = d * fun + (1 - d) * (0.3 + 0.7 * calm) * 0.6 + 0.15 * calm;
  s -= m.overlap * 1.5;
  const ratio = r.timeS / ctx.targetS;
  // Tolérance de ±8 % sur la durée, puis pénalité croissante.
  const dev = Math.max(0, Math.abs(ratio - 1) - 0.08);
  if (ctx.mode === 'loop') {
    s -= dev * 2.5;
    if (ratio > 1.3 || ratio < 0.65) s -= 2;
  } else {
    s -= dev * 2;
    if (r.timeS > ctx.maxS * 1.03) s -= 5;
    s -= (1 - d) * Math.max(0, r.timeS / ctx.fastS - 1) * 0.5;
  }
  return s;
}

function cellsOf(r) {
  const set = new Set();
  const pts = resample(r.shape, r.cum, 250);
  for (const p of pts) set.add(cellKey(p, 500));
  return set;
}

function similarity(a, b) {
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  return inter / Math.max(1, Math.min(a.size, b.size));
}

export function selectDiverse(cands, k, maxSim = 0.6) {
  const sorted = cands.slice().sort((a, b) => b.score - a.score);
  const chosen = [];
  for (const c of sorted) {
    if (chosen.length >= k) break;
    c.cells = c.cells || cellsOf(c.route);
    if (chosen.every((o) => similarity(o.cells, c.cells) < maxSim)) chosen.push(c);
  }
  if (chosen.length < Math.min(2, sorted.length)) {
    for (const c of sorted) if (!chosen.includes(c) && chosen.length < 2) chosen.push(c);
  }
  return chosen;
}

// --- Orchestration -----------------------------------------------------------

/*
 params = {
   mode: 'loop' | 'ab', start: [lat,lon], end: [lat,lon],
   durationMin (boucle), wishMin, maxMin (A→B), discovery: 0..1, fuelKm,
   settings, departure: Date
 }
 hooks = { onProgress(evt), control: { stopEarly: false }, signal }
*/
export async function planRoutes(params, hooks = {}) {
  const { settings } = params;
  const d = Math.max(0, Math.min(1, params.discovery));
  const signal = hooks.signal;
  const progress = (e) => hooks.onProgress && hooks.onProgress(e);
  const control = hooks.control || {};
  const seed = hashString(JSON.stringify([params.start, params.end, params.durationMin, d, Date.now() >> 16]));
  const rand = rng(seed);

  const ctx = { mode: params.mode, discovery: d };
  let reference = null;
  let area;

  if (params.mode === 'ab') {
    progress({ phase: 'reference' });
    const refs = await route([
      { lat: params.start[0], lon: params.start[1] },
      { lat: params.end[0], lon: params.end[1] },
    ], settings, { signal, alternates: d === 0 ? 2 : 0 });
    const refList = Array.isArray(refs) ? refs : [refs];
    reference = refList[0];
    ctx.fastS = reference.timeS;
    ctx.maxS = Math.max(params.maxMin * 60, ctx.fastS);
    ctx.targetS = abTargetMinutes(ctx.fastS / 60, params.wishMin, params.maxMin, d) * 60;
    progress({ phase: 'reference-done', route: reference, fastS: ctx.fastS, targetS: ctx.targetS });
    const D = haversine(params.start, params.end);
    area = { type: 'bbox', bbox: bbox([params.start, params.end], Math.min(60000, D * 0.8 + 10000)) };
    if (d === 0 || ctx.targetS <= ctx.fastS * 1.05) {
      // Au plus direct : l'itinéraire le plus rapide et ses variantes.
      progress({ phase: 'poi' });
      const pois = await fetchInterest(area, signal);
      const cands = refList.map((r, i) => ({ route: r, waypoints: [], key: 'REF' + i, isReference: i === 0 }));
      return finish(cands, pois, params, ctx, hooks, rand);
    }
  } else {
    ctx.targetS = params.durationMin * 60;
    const speed = 14.4 * (1 - 0.15 * d);
    const r = (ctx.targetS * speed / 1.35) / (2 * Math.PI * 0.9);
    area = { type: 'around', center: params.start, radius: Math.min(120000, r * 2.3 + 5000) };
  }

  progress({ phase: 'poi' });
  const pois = await fetchInterest(area, signal);
  progress({ phase: 'poi-done', count: pois.length });

  const total = params.mode === 'loop' ? 12 : 10;
  const cands = reference ? [{ route: reference, waypoints: [], key: 'REF', isReference: true }] : [];
  let scale = 1;
  let straightTarget = 0;
  if (params.mode === 'ab') {
    const D = haversine(params.start, params.end);
    const tau = Math.max(1.25, (reference.totalM) / Math.max(1, D));
    const Ltarget = reference.totalM * Math.pow(ctx.targetS / ctx.fastS, 0.85);
    straightTarget = Ltarget / tau;
  }
  let failures = 0;
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new AbortedError();
    if (control.stopEarly && cands.length >= 2) break;
    let cand;
    if (params.mode === 'loop') {
      cand = loopCandidate(i, params.start, ctx.targetS, d, pois, scale, rand);
    } else {
      const D = haversine(params.start, params.end);
      const st = D + (straightTarget - D) * scale;
      cand = abCandidate(i, params.start, params.end, st, d, pois, rand);
      if (!cand) continue;
    }
    const locs = [{ lat: params.start[0], lon: params.start[1] }];
    // Points de passage accrochés à une vraie route (ni autoroute, ni impasse résidentielle).
    for (const w of cand.waypoints) locs.push({ lat: w[0], lon: w[1], type: 'through', filter: WAYPOINT_FILTER });
    const end = params.mode === 'loop' ? params.start : params.end;
    locs.push({ lat: end[0], lon: end[1] });
    progress({ phase: 'candidates', done: i, total });
    try {
      const r = await route(locs, settings, { signal });
      cand.route = r;
      cands.push(cand);
      progress({ phase: 'candidate', route: r, done: i + 1, total, found: cands.length });
      // Calibrage progressif de la taille des boucles / détours sur la durée visée.
      const ratio = r.timeS / ctx.targetS;
      if (params.mode === 'loop') {
        scale *= Math.pow(Math.min(1.8, Math.max(0.55, 1 / ratio)), 0.7);
      } else {
        const extra = (r.timeS - ctx.fastS) / Math.max(60, ctx.targetS - ctx.fastS);
        scale *= Math.pow(Math.min(1.8, Math.max(0.55, 1 / Math.max(0.2, extra))), 0.6);
      }
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      if (e instanceof RouteError && (e.code === 'network' || e.code === 429)) {
        if (cands.length >= 2) break;
        throw e;
      }
      failures++;
      if (failures > 6 && cands.length === 0) throw new RouteError('Aucun parcours trouvé autour de ce point de départ', 'none');
    }
  }
  if (!cands.length) throw new RouteError('Aucun parcours trouvé, essaie un autre point de départ ou une autre durée', 'none');
  return finish(cands, pois, params, ctx, hooks, rand);
}

async function finish(cands, pois, params, ctx, hooks, rand) {
  const progress = (e) => hooks.onProgress && hooks.onProgress(e);
  progress({ phase: 'select' });
  for (const c of cands) {
    c.metrics = analyzeRoute(c.route, pois, params.mode);
    c.score = scoreRoute(c.metrics, c.route, ctx);
  }
  // En A→B on écarte ce qui dépasse la durée max (sauf l'itinéraire de référence).
  let pool = cands;
  if (params.mode === 'ab') {
    const ok = cands.filter((c) => c.isReference || c.route.timeS <= ctx.maxS * 1.05);
    if (ok.length) pool = ok;
  }
  const chosen = selectDiverse(pool, 4);

  progress({ phase: 'stops' });
  let stopPois = [];
  try {
    stopPois = await fetchStopPois(chosen.map((c) => c.route), params.settings, { signal: hooks.signal });
  } catch (e) {
    if (e instanceof AbortedError) throw e;
  }
  const departure = params.departure || new Date();
  for (const c of chosen) {
    const res = placeStops(c.route, stopPois, params.settings, params.fuelKm, departure);
    c.stops = res.stops;
    c.fuelWarning = res.fuelWarning;
  }
  nameRoutes(chosen, params.mode, ctx, rand);
  progress({ phase: 'done' });
  return {
    ctx,
    options: chosen.map((c, i) => ({
      id: c.key + '-' + i,
      name: c.name,
      badge: c.badge,
      mode: params.mode,
      start: params.start,
      end: params.mode === 'loop' ? params.start : params.end,
      waypoints: c.waypoints,
      route: c.route,
      metrics: c.metrics,
      stops: c.stops,
      fuelWarning: c.fuelWarning,
      isReference: !!c.isReference,
    })),
    pois,
  };
}

// Recalcule le parcours choisi en passant par les pauses (pour que le guidage y mène).
export async function routeWithStops(option, settings, { signal } = {}) {
  const r0 = option.route;
  const items = [];
  for (const w of option.waypoints) {
    const near = nearestOnLine(r0.shape, r0.cum, w);
    items.push({ along: near.along, lat: w[0], lon: w[1], type: 'through', filter: WAYPOINT_FILTER });
  }
  for (const s of option.stops) {
    const target = s.distFromRoute <= 250 ? s.point : s.routePoint;
    items.push({ along: s.along, lat: target[0], lon: target[1], type: 'break', stop: s });
  }
  items.sort((a, b) => a.along - b.along);
  const locs = [{ lat: option.start[0], lon: option.start[1] }, ...items, { lat: option.end[0], lon: option.end[1] }];
  const r = await route(locs, settings, { signal });
  // Chaque pause correspond à la fin d'une étape (leg).
  const stopsOrdered = items.filter((it) => it.stop).map((it) => it.stop);
  stopsOrdered.forEach((s, k) => {
    const leg = r.legs[k];
    if (!leg) return;
    s.along = r.cum[leg.end];
    s.timeS = 0;
    for (let j = 0; j <= k; j++) s.timeS += r.legs[j].timeS;
    s.legIndex = k;
  });
  return r;
}
