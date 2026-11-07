// Générateur de parcours « découverte ».
// Principe : on fabrique des parcours candidats (boucles en pétale ou détours),
// on les fait calculer par Valhalla, on les note, et on garde les meilleurs.
import {
  haversine, bearing, destination, angleDiff, resample, bbox, rng, hashString, cellKey,
  nearestOnLine, projectOnSegment,
} from './geo.js';
import { route, overpass, elementPoint, RouteError, AbortedError, routingProfile } from './services.js';
import { fetchStopPois, placeStops } from './stops.js';
import { nameFor, assignBadges } from './names.js';
import { cellsOfShape, coverage } from './store.js';

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
  const bb = area.type === 'around'
    ? bbox([area.center], area.radius)
    : area.bbox;
  // Attention : « out center; » (et non « out tags ») pour garder les coordonnées des nœuds.
  return `[out:json][timeout:25][bbox:${bb.s.toFixed(4)},${bb.w.toFixed(4)},${bb.n.toFixed(4)},${bb.e.toFixed(4)}];(
node["tourism"="viewpoint"];
node["mountain_pass"="yes"];
node["natural"="saddle"]["name"];
way["natural"="water"]["water"~"^(lake|reservoir)$"]["name"];
node["waterway"="waterfall"];
node["historic"~"^(castle|ruins|monastery|fort)$"]["name"];
way["historic"~"^(castle|fort)$"]["name"];
);out center;`;
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
    const els = await overpass(interestQuery(area), { signal, timeoutMs: 20000, maxTries: 2 });
    return els.map(classifyInterest).filter(Boolean);
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    return []; // sans points d'intérêt, on se contente des virages
  }
}

// --- Fabrication des candidats ----------------------------------------------

// Points de passage accrochés à de petites routes (ni grands axes, ni impasses résidentielles).
const WAYPOINT_FILTER = { min_road_class: 'unclassified', max_road_class: 'tertiary' };

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

// Demi-tours et tronçons parcourus deux fois. Pour une boucle, on tolère jusqu'à
// `sharedEndsM` de route commune entre le début et la fin (quitter la maison et y revenir).
export function retraceInfo(r, mode, sharedEndsM = 10000) {
  const step = 25;
  const pts = resample(r.shape, r.cum, step);
  const total = (pts.length - 1) * step;
  const cell = 40;
  const grid = new Map();
  const keyOf = (p) => {
    const y = Math.floor((p[0] * 111320) / cell);
    const x = Math.floor((p[1] * 111320 * Math.cos(p[0] * Math.PI / 180)) / cell);
    return [x, y];
  };
  const keys = pts.map(keyOf);
  const retraced = new Uint8Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = keys[i];
    const along = i * step;
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) {
      const list = grid.get((x + dx) + ':' + (y + dy));
      if (!list) continue;
      for (const j of list) {
        if (along - j * step < 400) continue;
        // Même route = quasiment sur le même tracé (quelques mètres) ; des lacets voisins restent à 20 m et plus.
        let dmin = Infinity;
        if (j > 0) dmin = Math.min(dmin, projectOnSegment(pts[i], pts[j - 1], pts[j]).dist);
        if (j < pts.length - 1) dmin = Math.min(dmin, projectOnSegment(pts[i], pts[j], pts[j + 1]).dist);
        if (dmin > 8) continue;
        const sharedEnds = mode === 'loop' && along >= total - sharedEndsM && j * step <= sharedEndsM;
        if (!sharedEnds) { hit = true; break; }
      }
    }
    if (hit) retraced[i] = 1;
    const k = x + ':' + y;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  let maxRun = 0, run = 0, retracedM = 0, runEnd = -1;
  for (let i = 0; i < pts.length; i++) {
    if (retraced[i]) { run += step; retracedM += step; if (run > maxRun) { maxRun = run; runEnd = i; } } else run = 0;
  }
  const uTurnMan = r.maneuvers.filter((m) => m.type === 12 || m.type === 13);
  // Endroit du demi-tour : bout de l'aller-retour le plus long, ou manœuvre de demi-tour.
  let point = null;
  if (runEnd >= 0) point = pts[Math.max(0, runEnd - Math.round(maxRun / step))];
  else if (uTurnMan.length) point = r.shape[uTurnMan[0].begin];
  return { maxRun, retracedM, ratio: total ? retracedM / total : 0, uTurns: uTurnMan.length, point };
}

export function hasUTurn(info) {
  return info.uTurns > 0 || info.maxRun > 300 || info.ratio > 0.03;
}

export function scoreRoute(m, r, ctx) {
  const d = ctx.discovery;
  const curvN = Math.min(1, m.degPerKm / 160);
  const panoN = Math.min(1, m.panoramaScore / 8);
  const manN = Math.min(1, m.manDensity / 8);
  const fun = (0.55 + 0.3 * d) * curvN + (0.45 - 0.3 * d) * panoN + 0.3 * d * curvN;
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

// --- Goûts appris -------------------------------------------------------------

export function featureVector(m) {
  return {
    curv: Math.min(1, m.degPerKm / 160),
    pano: Math.min(1, m.panoramaScore / 8),
    lake: Math.min(1, (m.lakes?.length || 0) / 2),
    calm: 1 - Math.min(1, m.manDensity / 8),
  };
}

function personalBonus(f, prefs) {
  if (!prefs) return 0;
  return 0.8 * ((prefs.curv || 0) * (f.curv - 0.5) + (prefs.pano || 0) * (f.pano - 0.5)
    + (prefs.lake || 0) * (f.lake - 0.5) + (prefs.calm || 0) * (f.calm - 0.5));
}

const DIRS = ['le nord', 'le nord-est', 'l\'est', 'le sud-est', 'le sud', 'le sud-ouest', 'l\'ouest', 'le nord-ouest'];
const dirName = (brg) => DIRS[Math.round(((brg % 360) + 360) % 360 / 45) % 8];

// --- Session de recherche (résultats publiés au fil de l'eau) -----------------

/*
 params = { mode, start, end, durationMin, wishMin, maxMin, discovery (0..1), fuelKm, settings, departure }
 hooks  = { onStep(text), onRoute(option), onUpdate(option), onProgress({computed, budget, shown}), onDone(info), onError(err) }
 memory = { exclusions: [{why, cells:Set}], prefs }
*/
export class PlanSession {
  constructor(params, hooks = {}, memory = {}) {
    this.params = params;
    this.hooks = hooks;
    this.exclusions = memory.exclusions || [];
    this.prefs = memory.prefs || null;
    this.d = Math.max(0, Math.min(1, params.discovery));
    this.ctrl = new AbortController();
    this.rand = rng(hashString(JSON.stringify([params.start, params.end, params.durationMin, this.d, Date.now() >> 16])));
    this.ctx = { mode: params.mode, discovery: this.d };
    this.shown = [];          // parcours proposés (y compris retirés, marqués removed)
    this.i = 0;               // indice du prochain candidat
    this.scale = 1;
    this.usedNames = new Set();
    this.pendingStops = [];
    this.stats = { computed: 0, rejectedRide: 0, rejectedDown: 0, rejectedSimilar: 0, rejectedQuality: 0, rejectedUturn: 0, failures: 0 };
    this.profile = routingProfile(params.settings, this.d);
    this.running = false;
    this.stopRequested = false;
    this.pois = [];
    this.stopPoiCache = new Map();
  }

  get signal() { return this.ctrl.signal; }
  get options() { return this.shown.filter((o) => !o.removed); }
  step(t) { this.hooks.onStep?.(t); }
  cancel() { this.ctrl.abort(); }
  stop() { this.stopRequested = true; }

  async start() {
    const p = this.params;
    const settings = p.settings;
    if (p.mode === 'ab') {
      this.step('Calcul du trajet le plus rapide…');
      const refs = await route([
        { lat: p.start[0], lon: p.start[1] },
        { lat: p.end[0], lon: p.end[1] },
      ], settings, { signal: this.signal, alternates: this.d === 0 ? 2 : 0 });
      const list = Array.isArray(refs) ? refs : [refs];
      this.reference = list[0];
      this.refAlternates = list.slice(1);
      this.ctx.fastS = this.reference.timeS;
      this.ctx.maxS = Math.max(p.maxMin * 60, this.ctx.fastS);
      this.ctx.targetS = abTargetMinutes(this.ctx.fastS / 60, p.wishMin, p.maxMin, this.d) * 60;
      const D = haversine(p.start, p.end);
      this.area = { type: 'bbox', bbox: bbox([p.start, p.end], Math.min(60000, D * 0.8 + 10000)) };
      const tau = Math.max(1.25, this.reference.totalM / Math.max(1, D));
      const effTarget = Math.max(this.ctx.targetS, this.ctx.fastS * 1.15);
      this.straightTarget = (this.reference.totalM * Math.pow(effTarget / this.ctx.fastS, 0.85)) / tau;
    } else {
      this.ctx.targetS = p.durationMin * 60;
      const speed = 14.4 * (1 - 0.15 * this.d);
      const r = (this.ctx.targetS * speed / 1.35) / (2 * Math.PI * 0.9);
      this.area = { type: 'around', center: p.start, radius: Math.min(120000, r * 2.3 + 5000) };
    }
    this.step('Repérage des cols, belvédères et lacs…');
    this.pois = await fetchInterest(this.area, this.signal);
    this.step(this.pois.length ? `${this.pois.length} cols, belvédères et lacs repérés` : 'Pas de points d\'intérêt trouvés, on se fie aux virages');
    this.hooks.onPois?.(this.pois.length);

    if (p.mode === 'ab' && (this.d === 0 || this.ctx.targetS <= this.ctx.fastS * 1.05)) {
      // Au plus direct : le trajet le plus rapide et ses variantes, même s'ils ont déjà été faits.
      [this.reference, ...this.refAlternates].forEach((r, k) => this.consider({ route: r, waypoints: [], key: 'REF' + k, isReference: k === 0 }, { ignoreHistory: true }));
      await this.flushStops();
      this.finishRun(0);
      return;
    }
    await this.run(32, 8);
  }

  async more() {
    if (this.running) return;
    this.stopRequested = false;
    // Pour « plus », on élargit un peu les variantes.
    this.moreRounds = (this.moreRounds || 0) + 1;
    await this.run(16, 8);
  }

  nextCandidate() {
    const p = this.params;
    const i = this.i++;
    const prefs = this.prefs || {};
    const snapBias = Math.max(0, Math.max(prefs.pano || 0, prefs.curv || 0, prefs.lake || 0)) * 0.3;
    if (p.mode === 'loop') {
      const round = Math.floor(i / LOOP_BEARINGS.length);
      const sc = this.scale * (1 + [0, 0.12, -0.1, 0.2, -0.15][round % 5]);
      const c = loopCandidate(i, p.start, this.ctx.targetS, Math.min(1, this.d + snapBias), this.pois, sc, this.rand);
      c.label = 'boucle vers ' + dirName(bearing(p.start, c.waypoints[0]) + 30);
      return c;
    }
    const D = haversine(p.start, p.end);
    const round = Math.floor(i / 10);
    const st = D + (this.straightTarget - D) * this.scale * (1 + [0, 0.1, -0.1, 0.18][round % 4]);
    const c = abCandidate(i, p.start, p.end, st, Math.min(1, this.d + snapBias), this.pois, this.rand);
    if (c) c.label = 'détour par ' + dirName(bearing(p.start, c.waypoints[Math.floor(c.waypoints.length / 2)]));
    return c;
  }

  async run(budget, targetNew) {
    this.running = true;
    const p = this.params;
    let computed = 0, added = 0, netFailures = 0;
    try {
      while (computed < budget && added < targetNew && !this.stopRequested) {
        if (this.signal.aborted) throw new AbortedError();
        const cand = this.nextCandidate();
        if (!cand) { computed++; continue; }
        const num = this.stats.computed + 1;
        const poiName = cand.snap ? this.pois.find((x) => cand.waypoints.some((w) => haversine(w, x.point) < 50) && x.name)?.name : null;
        this.step(`Parcours ${num} : ${cand.label}${poiName ? ' par ' + poiName : ''}…`);
        const locs = [{ lat: p.start[0], lon: p.start[1] }];
        for (const w of cand.waypoints) locs.push({ lat: w[0], lon: w[1], type: 'through', filter: WAYPOINT_FILTER });
        const end = p.mode === 'loop' ? p.start : p.end;
        locs.push({ lat: end[0], lon: end[1] });
        try {
          cand.route = await route(locs, p.settings, { signal: this.signal, profile: this.profile });
          netFailures = 0;
          // Calibrage progressif sur la durée visée.
          const ratio = cand.route.timeS / this.ctx.targetS;
          if (p.mode === 'loop') this.scale *= Math.pow(Math.min(1.8, Math.max(0.55, 1 / ratio)), 0.6);
          else {
            const extra = (cand.route.timeS - this.ctx.fastS) / Math.max(60, this.ctx.targetS - this.ctx.fastS);
            this.scale *= Math.pow(Math.min(1.8, Math.max(0.55, 1 / Math.max(0.2, extra))), 0.5);
          }
          this.lastReject = null;
          let ok = this.consider(cand);
          // Réparation : on retire le point de passage qui provoque le demi-tour et on recalcule une fois.
          const minLeft = p.mode === 'loop' ? 2 : 1;
          if (!ok && this.lastReject?.why === 'uturn' && this.lastReject.info.point && cand.waypoints.length > minLeft) {
            const at = this.lastReject.info.point;
            let k = 0;
            cand.waypoints.forEach((w, j) => { if (haversine(w, at) < haversine(cand.waypoints[k], at)) k = j; });
            if (haversine(cand.waypoints[k], at) < 8000) {
              cand.waypoints = cand.waypoints.filter((_, j) => j !== k);
              const locs2 = [{ lat: p.start[0], lon: p.start[1] }];
              for (const w of cand.waypoints) locs2.push({ lat: w[0], lon: w[1], type: 'through', filter: WAYPOINT_FILTER });
              locs2.push({ lat: end[0], lon: end[1] });
              this.step(`Parcours ${num} : correction d'un demi-tour…`);
              try {
                cand.route = await route(locs2, p.settings, { signal: this.signal, profile: this.profile });
                this.stats.repairs = (this.stats.repairs || 0) + 1;
                this.lastReject = null;
                ok = this.consider(cand);
              } catch (e2) {
                if (e2 instanceof AbortedError) throw e2;
              }
            }
          }
          if (!ok && this.lastReject?.why === 'uturn') this.stats.rejectedUturn++;
          if (ok) added++;
        } catch (e) {
          if (e instanceof AbortedError) throw e;
          if (e instanceof RouteError && (e.code === 'network' || e.code === 429)) {
            if (++netFailures >= 3) {
              if (this.options.length) break;
              throw e;
            }
          } else this.stats.failures++;
        }
        computed++;
        this.stats.computed++;
        this.hooks.onProgress?.({ computed, budget, shown: this.options.length });
        if (this.pendingStops.length >= 3) await this.flushStops();
      }
      await this.flushStops();
      this.finishRun(added);
    } catch (e) {
      if (!(e instanceof AbortedError)) this.hooks.onError?.(e);
    } finally {
      this.running = false;
    }
  }

  // Évalue un candidat et le publie s'il est bon, nouveau et différent des autres.
  consider(cand, { ignoreHistory = false } = {}) {
    const r = cand.route;
    const m = analyzeRoute(r, this.pois, this.params.mode);
    const ratio = r.timeS / this.ctx.targetS;
    if (!cand.isReference) {
      const badDuration = this.params.mode === 'loop' ? (ratio < 0.75 || ratio > 1.2) : (r.timeS > this.ctx.maxS * 1.05);
      if (badDuration) { this.stats.rejectedQuality++; return false; }
      // Zéro demi-tour : on écarte tout parcours qui revient sur ses pas.
      const rt = retraceInfo(r, this.params.mode);
      if (hasUTurn(rt)) { this.lastReject = { why: 'uturn', info: rt }; return false; }
    }
    const cells = cellsOfShape(r.shape);
    if (!ignoreHistory) {
      for (const ex of this.exclusions) {
        if (coverage(cells, ex.cells) >= 0.6) {
          if (ex.why === 'ride') this.stats.rejectedRide++; else this.stats.rejectedDown++;
          return false;
        }
      }
    }
    for (const o of this.shown) {
      const sim = coverage(cells, o.cells) ;
      const sim2 = coverage(o.cells, cells);
      if (Math.max(sim, sim2) >= 0.6) { this.stats.rejectedSimilar++; return false; }
    }
    const f = featureVector(m);
    const score = scoreRoute(m, r, this.ctx) + personalBonus(f, this.prefs);
    const option = {
      id: 'o' + Date.now().toString(36) + '-' + this.shown.length,
      key: cand.key,
      mode: this.params.mode,
      start: this.params.start,
      end: this.params.mode === 'loop' ? this.params.start : this.params.end,
      waypoints: cand.waypoints,
      route: r,
      metrics: m,
      features: f,
      score,
      cells,
      stops: [],
      stopsReady: false,
      isReference: !!cand.isReference,
      profile: r.profile === 'motor_scooter' ? this.profile : null,
    };
    option.name = nameFor(option, this.params.mode, this.rand, this.usedNames);
    this.usedNames.add(option.name);
    this.shown.push(option);
    this.pendingStops.push(option);
    this.hooks.onRoute?.(option);
    return true;
  }

  async flushStops(list = null) {
    const todo = (list || this.pendingStops).filter((o) => !o.stopsReady);
    if (!list) this.pendingStops = [];
    if (!todo.length) return;
    this.step('Recherche des cafés et stations le long des parcours…');
    let pois = [];
    try {
      pois = await fetchStopPois(todo.map((o) => o.route), this.params.settings, { signal: this.signal });
    } catch (e) {
      if (e instanceof AbortedError) throw e;
    }
    for (const o of todo) {
      const res = placeStops(o.route, pois, this.params.settings, this.params.fuelKm, this.params.departure || new Date());
      o.stops = res.stops;
      o.fuelWarning = res.fuelWarning;
      o.stopsReady = true;
      o.stopPois = pois.length;
      this.hooks.onUpdate?.(o);
    }
  }

  // Pauses d'un parcours ouvert avant que la recherche ne les ait calculées.
  async ensureStops(option) {
    if (option.stopsReady) return;
    this.pendingStops = this.pendingStops.filter((o) => o !== option);
    await this.flushStops([option]);
  }

  remove(option) { option.removed = true; this.assignBadges(); }
  restore(option) { option.removed = false; this.assignBadges(); }

  assignBadges() {
    assignBadges(this.options);
  }

  finishRun(added) {
    this.assignBadges();
    const opts = this.options;
    const best = opts.slice().sort((a, b) => b.score - a.score)[0];
    for (const o of opts) o.best = o === best;
    this.step(opts.length ? `${opts.length} parcours proposés` : 'Aucun parcours');
    this.hooks.onDone?.({ added, total: opts.length, stats: { ...this.stats } });
  }
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
  const r = await route(locs, settings, { signal, profile: option.profile || null });
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
