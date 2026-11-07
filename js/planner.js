// Générateur de parcours « découverte ».
// Principe : on fabrique des parcours candidats (boucles en pétale ou détours),
// on les fait calculer par Valhalla, on les note, et on garde les meilleurs.
import {
  haversine, bearing, destination, angleDiff, resample, bbox, rng, hashString, cellKey,
  nearestOnLine, projectOnSegment,
} from './geo.js';
import { route, overpass, elementPoint, RouteError, AbortedError, routingProfile, traceEdges, wayTags, tracksInArea, finalizeRoute, traceRoute, joinRoutes, sliceRoute, timeAt } from './services.js';
import { offroadProfile, maxGradeFor, analyzeOffroad, offroadScore, isOffroadEdge, gradeOf, legalityOf, tetIndex } from './offroad.js';
import { tetSectionsNear, tetLoopCandidate, tetBackPoint } from './traces.js';
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

// Boucle tout-terrain : plus de points de passage (3 à 8), chacun accroché à une piste.
export function offroadLoopCandidate(i, start, targetS, share, tracks, scale, rand) {
  const v = (1 - share) * 14 + share * 7; // m/s
  const L = targetS * v * scale;
  const P = L / 1.35;
  const n = Math.max(3, Math.min(8, Math.round(3 + 6 * share)));
  const k = n + 1;
  const polyFactor = Math.sin(Math.PI / k) / (Math.PI / k);
  const r = P / (2 * Math.PI * polyFactor);
  const theta = (LOOP_BEARINGS[i % LOOP_BEARINGS.length] + (rand() - 0.5) * 30 + 360) % 360;
  const center = destination(start, theta, r);
  const startAngle = (theta + 180) % 360;
  const dir = i % 4 < 2 ? 1 : -1;
  const used = new Set();
  const waypoints = [];
  let snapped = 0;
  for (let j = 1; j <= n; j++) {
    const ang = startAngle + dir * (j * 360 / k + (rand() - 0.5) * 10);
    let pt = destination(center, ang, r * (0.9 + rand() * 0.2));
    const tr = snapToPoi(pt, tracks, Math.max(2500, r * 0.35), used);
    if (tr) { pt = tr.point; snapped++; }
    waypoints.push(pt);
  }
  return { waypoints, snap: snapped > 0, key: 'OL' + i };
}

// Densifie un détour A→B avec des pistes (tout-terrain).
export function densifyWithTracks(A, B, waypoints, tracks, share) {
  const line = [A, ...waypoints, B];
  const cum = [0];
  for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + haversine(line[k - 1], line[k]));
  const total = cum[cum.length - 1];
  const count = Math.max(2, Math.min(7, Math.round(2 + 6 * share)));
  const used = new Set();
  const out = [];
  for (let j = 1; j <= count; j++) {
    const d = (j / (count + 1)) * total;
    let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
    const f = (d - cum[k - 1]) / Math.max(1, cum[k] - cum[k - 1]);
    const p = [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * f, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * f];
    const tr = snapToPoi(p, tracks, Math.max(3000, total * 0.06), used);
    out.push(tr ? tr.point : p);
  }
  return out;
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
    this.terrain = params.terrain || 'road';
    this.off = this.terrain === 'offroad' ? { share: 0.4, level: 'intermediate', bikeType: 'heavy', maxSlowMin: 20, legality: 'standard', useTet: true, ...(params.offroad || {}) } : null;
    this.profile = this.off ? offroadProfile(params.settings, this.off.share) : routingProfile(params.settings, this.d);
    if (this.off) {
      this.off.maxGrade = maxGradeFor(this.off.level, this.off.bikeType);
      this.ctx.share = this.off.share;
      this.ctx.maxSlowMin = this.off.maxSlowMin;
      Object.assign(this.stats, { rejectedHard: 0, rejectedIllegal: 0, rejectedOverheat: 0, rejectedNoTrack: 0 });
    }
    this.traces = memory.traces || [];
    this.tagCache = new Map();
    this.trackPois = [];
    this.tetSections = [];
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
    if (this.off) await this.prepareOffroad();

    if (p.mode === 'ab' && (this.d === 0 || this.ctx.targetS <= this.ctx.fastS * 1.05)) {
      // Au plus direct : le trajet le plus rapide et ses variantes, même s'ils ont déjà été faits.
      for (const [k, r] of [this.reference, ...this.refAlternates].entries()) {
        await this.consider({ route: r, waypoints: [], key: 'REF' + k, isReference: k === 0 }, { ignoreHistory: true });
      }
      await this.flushStops();
      this.finishRun(0);
      return;
    }
    await this.run(32, 8);
  }

  // Pistes de la zone (points d'accroche) et traces importées (TET) proches du départ.
  async prepareOffroad() {
    const p = this.params;
    const bb = this.area.type === 'around' ? bbox([this.area.center], this.area.radius) : this.area.bbox;
    this.step('Repérage des pistes autour de toi…');
    try {
      const tracks = await tracksInArea(bb, { signal: this.signal });
      this.trackPois = tracks.map((t) => {
        const g = gradeOf(t.tags);
        const lg = legalityOf(t.tags, { offroad: true });
        return { id: 'w' + t.id, kind: 'track', name: t.tags.name || '', point: t.point, grade: g.grade, weight: (lg === 'green' ? 3 : 2) - Math.max(0, g.grade - 2) * 0.3 };
      }).filter((t) => t.grade <= this.off.maxGrade);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      this.trackPois = [];
    }
    // Traces importées : on ne garde que les morceaux dans la zone.
    const inZone = (pt) => pt[0] >= bb.s && pt[0] <= bb.n && pt[1] >= bb.w && pt[1] <= bb.e;
    const near = this.traces.filter((t) => t.points.some(inZone));
    this.tet = tetIndex(near.map((t) => ({ points: t.points.filter(inZone) })).filter((t) => t.points.length > 1));
    if (this.off.useTet && near.length && p.mode === 'loop') {
      const loopKm = this.loopKm();
      this.tetSections = tetSectionsNear(near, p.start, loopKm * 1000 / 2.3);
    }
    this.step(`${this.trackPois.length} pistes repérées` + (this.tetSections.length ? ` · ${this.tetSections.length} tronçon${this.tetSections.length > 1 ? 's' : ''} de trace (TET) à portée` : ''));
  }

  // Boucle par un tronçon de trace : approche, tronçon suivi exactement (trace_route), retour.
  async routeTet(cand) {
    const p = this.params;
    const pts = cand.tetPts;
    const a = pts[0], b = pts[pts.length - 1];
    const back = tetBackPoint(p.start, cand.backFirst ? a : b, cand.side || 1, cand.backFactor || 0.3);
    cand.waypoints = cand.backFirst ? [back, a, b] : [a, b, back];
    const opt = { signal: this.signal, profile: this.profile };
    const S0 = { lat: p.start[0], lon: p.start[1] };
    const B = { lat: back[0], lon: back[1], type: 'through' };
    // Départ sur la trace (ou retour qui y finit) : pas d'approche à calculer.
    const near = (x) => haversine(x, p.start) < 150;
    const r1 = cand.backFirst || !near(a) ? await route(cand.backFirst ? [S0, B, { lat: a[0], lon: a[1] }] : [S0, { lat: a[0], lon: a[1] }], p.settings, opt) : null;
    const r2 = await traceRoute(pts, p.settings, { signal: this.signal });
    const r3 = !cand.backFirst || !near(b) ? await route(cand.backFirst ? [{ lat: b[0], lon: b[1] }, S0] : [{ lat: b[0], lon: b[1] }, B, S0], p.settings, opt) : null;
    const r = joinTet(r1, r2, r3, cand.traceName);
    cand.tetRange = [r1 ? r1.totalM : 0, (r1 ? r1.totalM : 0) + r2.totalM];
    return r;
  }

  loopKm() {
    const share = this.off ? this.off.share : 0;
    const v = (1 - share) * 14 + share * 7; // m/s
    return this.ctx.targetS * v / 1000 * (this.scaleTet || 1);
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
    // Une fois sur trois, une boucle par un tronçon de trace (TET), chaque combinaison essayée une seule fois.
    if (this.off && p.mode === 'loop' && this.tetSections.length && !this.tetDone && i % 3 === 0) {
      for (let guard = 0; guard < 64; guard++) {
        const c = tetLoopCandidate(this.tetI = (this.tetI ?? -1) + 1, p.start, this.loopKm(), this.off.share, this.tetSections, this.rand);
        if (c === null) { this.tetDone = true; break; }
        if (c) return c;
      }
    }
    if (this.off) {
      // Points de passage accrochés à des pistes (selon ton niveau), plus rarement à des belvédères.
      const pois = this.trackPois.length ? this.trackPois.concat(this.pois.filter((x) => x.kind !== 'lake')) : this.pois;
      const tracks = this.trackPois.length ? this.trackPois : pois;
      if (p.mode === 'loop') {
        const round = Math.floor(i / LOOP_BEARINGS.length);
        const sc = this.scale * (1 + [0, 0.12, -0.1, 0.2, -0.15][round % 5]);
        const c = offroadLoopCandidate(i, p.start, this.ctx.targetS, this.off.share, tracks, sc, this.rand);
        c.label = 'boucle vers ' + dirName(bearing(p.start, c.waypoints[0]) + 30) + ' par les pistes';
        return c;
      }
      const D = haversine(p.start, p.end);
      const st = D + (this.straightTarget - D) * this.scale * (0.85 - 0.25 * this.off.share);
      const c = abCandidate(i, p.start, p.end, Math.max(st, D * 1.1), 0.9, pois, this.rand);
      if (c) {
        c.waypoints = densifyWithTracks(p.start, p.end, c.waypoints, tracks, this.off.share);
        c.label = 'détour par ' + dirName(bearing(p.start, c.waypoints[Math.floor(c.waypoints.length / 2)])) + ' par les pistes';
      }
      return c;
    }
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
        const wf = this.off ? null : WAYPOINT_FILTER;
        for (const w of cand.waypoints) locs.push({ lat: w[0], lon: w[1], type: 'through', filter: wf });
        const end = p.mode === 'loop' ? p.start : p.end;
        locs.push({ lat: end[0], lon: end[1] });
        try {
          cand.route = cand.tet ? await this.routeTet(cand) : await route(locs, p.settings, { signal: this.signal, profile: this.profile });
          netFailures = 0;
          this.lastReject = null;
          let ok = await this.consider(cand);
          // Calibrage progressif sur la durée visée (après l'éventuel ajustement tout-terrain de la durée).
          // Les boucles par le TET ont leur propre échelle.
          const ratio = cand.route.timeS / this.ctx.targetS;
          if (p.mode === 'loop' && cand.tet) this.scaleTet = Math.min(2.2, Math.max(0.5, (this.scaleTet || 1) * Math.pow(Math.min(1.8, Math.max(0.55, 1 / ratio)), 0.6)));
          else if (p.mode === 'loop') this.scale *= Math.pow(Math.min(1.8, Math.max(0.5, 1 / ratio)), this.off ? 0.8 : 0.6);
          else {
            const extra = (cand.route.timeS - this.ctx.fastS) / Math.max(60, this.ctx.targetS - this.ctx.fastS);
            this.scale *= Math.pow(Math.min(1.8, Math.max(0.55, 1 / Math.max(0.2, extra))), 0.5);
          }
          // Réparation : on retire le point de passage qui provoque le demi-tour et on recalcule une fois.
          // Boucle par le TET : on parcourt le tronçon dans l'autre sens et on revient par l'autre côté.
          const minLeft = p.mode === 'loop' ? 2 : 1;
          if (!ok && cand.tet && this.lastReject?.why === 'uturn') {
            // Retour (ou aller) par l'autre côté, puis plus loin de la trace.
            for (const [flip, factor] of [[true, 0.3], [false, 0.55]]) {
              if (ok || this.lastReject?.why !== 'uturn') break;
              if (flip) cand.side = -cand.side;
              cand.backFactor = factor;
              this.step(`Parcours ${num} : correction d'un demi-tour…`);
              try {
                cand.route = await this.routeTet(cand);
                this.stats.repairs = (this.stats.repairs || 0) + 1;
                this.lastReject = null;
                ok = await this.consider(cand);
              } catch (e2) {
                if (e2 instanceof AbortedError) throw e2;
                break;
              }
            }
          } else if (!ok && this.lastReject?.why === 'uturn' && this.lastReject.info.point && cand.waypoints.length > minLeft) {
            const at = this.lastReject.info.point;
            let k = 0;
            cand.waypoints.forEach((w, j) => { if (haversine(w, at) < haversine(cand.waypoints[k], at)) k = j; });
            if (haversine(cand.waypoints[k], at) < 8000) {
              cand.waypoints = cand.waypoints.filter((_, j) => j !== k);
              const locs2 = [{ lat: p.start[0], lon: p.start[1] }];
              for (const w of cand.waypoints) locs2.push({ lat: w[0], lon: w[1], type: 'through', filter: wf });
              locs2.push({ lat: end[0], lon: end[1] });
              this.step(`Parcours ${num} : correction d'un demi-tour…`);
              try {
                cand.route = await route(locs2, p.settings, { signal: this.signal, profile: this.profile });
                this.stats.repairs = (this.stats.repairs || 0) + 1;
                this.lastReject = null;
                ok = await this.consider(cand);
              } catch (e2) {
                if (e2 instanceof AbortedError) throw e2;
              }
            }
          }
          if (!ok && this.lastReject?.why === 'uturn') this.stats.rejectedUturn++;
          if (!ok && this.lastReject?.why && this.lastReject.why !== 'uturn') this.stats[this.lastReject.why] = (this.stats[this.lastReject.why] || 0) + 1;
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
  async consider(cand, { ignoreHistory = false } = {}) {
    const r = cand.route;
    // Tout-terrain : voies empruntées, difficulté, légalité, alternance piste / route.
    let oa = null;
    if (this.off) {
      try {
        const edges = await traceEdges(r.shape, { signal: this.signal });
        const missing = [...new Set(edges.filter(isOffroadEdge).map((e) => e.way_id))].filter((id) => id != null && !this.tagCache.has(id));
        if (missing.length) {
          const tags = await wayTags(missing, { signal: this.signal });
          for (const id of missing) this.tagCache.set(id, tags.get(id) || {});
        }
        oa = analyzeOffroad(edges, this.tagCache, this.tet, { maxGrade: this.off.maxGrade, maxSlowMin: this.off.maxSlowMin });
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        oa = null; // analyse impossible : parcours gardé mais signalé « non vérifié »
      }
      if (oa) {
        // Durée réaliste : on roule moins vite sur piste que ne l'estime le moteur d'itinéraires.
        if (oa.extraMin > 0 && !r.offroadAdjusted) {
          r.timeS += oa.extraMin * 60;
          r.offroadAdjusted = true;
          finalizeRoute(r);
        }
        if (oa.legal.red > 0.1) { this.lastReject = { why: 'rejectedIllegal' }; return false; }
        if (this.off.legality === 'strict' && oa.legal.orange > 0.5) { this.lastReject = { why: 'rejectedIllegal' }; return false; }
        if (oa.tooHard) { this.lastReject = { why: 'rejectedHard' }; return false; }
        if (oa.longestSlowMin > this.off.maxSlowMin * (2 + 2 * this.off.share)) { this.lastReject = { why: 'rejectedOverheat' }; return false; }
        if (this.off.share >= 0.15 && oa.offKm < 2 && !(cand.tet && oa.tetKm >= 5)) { this.lastReject = { why: 'rejectedNoTrack' }; return false; }
      }
    }
    const m = analyzeRoute(r, this.pois, this.params.mode);
    const ratio = r.timeS / this.ctx.targetS;
    if (!cand.isReference) {
      const badDuration = this.params.mode === 'loop' ? (ratio < 0.75 || ratio > 1.2) : (r.timeS > this.ctx.maxS * 1.05);
      if (badDuration) { this.lastReject = { why: 'rejectedQuality' }; return false; }
      // Zéro demi-tour : on écarte tout parcours qui revient sur ses pas.
      const rt = retraceInfo(r, this.params.mode);
      if (hasUTurn(rt)) { this.lastReject = { why: 'uturn', info: rt }; return false; }
    }
    const cells = cellsOfShape(r.shape);
    if (!ignoreHistory) {
      for (const ex of this.exclusions) {
        if (coverage(cells, ex.cells) >= 0.6) {
          this.lastReject = { why: ex.why === 'ride' ? 'rejectedRide' : 'rejectedDown' };
          return false;
        }
      }
    }
    for (const o of this.shown) {
      const sim = coverage(cells, o.cells) ;
      const sim2 = coverage(o.cells, cells);
      if (Math.max(sim, sim2) >= 0.6) { this.lastReject = { why: 'rejectedSimilar' }; return false; }
    }
    const f = featureVector(m);
    let score = scoreRoute(m, r, this.ctx) + personalBonus(f, this.prefs);
    if (this.off) score += oa ? offroadScore(oa, this.ctx) : -1;
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
      profile: this.off ? this.profile : (r.profile === 'motor_scooter' ? this.profile : null),
      terrain: this.terrain,
      tetRange: cand.tetRange || null,
      backFirst: !!cand.backFirst,
      traceName: cand.traceName || null,
      offroad: this.off ? (oa ? { ...oa, checked: true, level: this.off.level, maxGradeAllowed: this.off.maxGrade, tet: !!cand.tet } : { checked: false }) : null,
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
  if (option.tetRange) return routeTetWithStops(option, settings, { signal });
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

// Boucle par le TET : on garde le tronçon de trace tel quel, on recalcule l'approche et le retour
// en passant par les pauses. Les pauses situées sur le tronçon restent signalées en chemin.
async function routeTetWithStops(option, settings, { signal } = {}) {
  const r0 = option.route;
  const [m0, m1] = option.tetRange;
  const mid = sliceRoute(r0, m0, m1);
  const a = mid.shape[0], b = mid.shape[mid.shape.length - 1];
  const stopItem = (s) => { const t = s.distFromRoute <= 250 ? s.point : s.routePoint; return { along: s.along, lat: t[0], lon: t[1], type: 'break', stop: s }; };
  const before = option.stops.filter((s) => s.along < m0 - 200).sort((x, y) => x.along - y.along);
  const after = option.stops.filter((s) => s.along > m1 + 200).sort((x, y) => x.along - y.along);
  const back = option.backFirst ? option.waypoints[0] : option.waypoints[2];
  const beforeItems = before.map(stopItem);
  const afterItems = after.map(stopItem);
  if (back) {
    const nb = nearestOnLine(r0.shape, r0.cum, back);
    const list = option.backFirst ? beforeItems : afterItems;
    list.push({ along: nb.along, lat: back[0], lon: back[1], type: 'through' });
    list.sort((x, y) => x.along - y.along);
  }
  const close = (x, y) => haversine(x, y) < 150;
  const ra = beforeItems.length || !close(a, option.start) ? await route([{ lat: option.start[0], lon: option.start[1] }, ...beforeItems, { lat: a[0], lon: a[1] }], settings, { signal, profile: option.profile || null }) : null;
  const rb = afterItems.length || !close(b, option.end) ? await route([{ lat: b[0], lon: b[1] }, ...afterItems, { lat: option.end[0], lon: option.end[1] }], settings, { signal, profile: option.profile || null }) : null;
  const r = joinTet(ra, mid, rb, option.traceName);
  const legTime = (k) => r.legs.slice(0, k + 1).reduce((acc, l) => acc + l.timeS, 0);
  before.forEach((s, k) => { const leg = r.legs[k]; if (leg) { s.along = r.cum[leg.end]; s.timeS = legTime(k); s.legIndex = k; } });
  const base = (ra ? ra.legs.length : 0) + mid.legs.length;
  after.forEach((s, k) => { const k2 = base + k; const leg = r.legs[k2]; if (leg) { s.along = r.cum[leg.end]; s.timeS = legTime(k2); s.legIndex = k2; } });
  for (const s of option.stops) {
    if (before.includes(s) || after.includes(s)) continue;
    const near = nearestOnLine(r.shape, r.cum, s.routePoint || s.point);
    s.along = near.along; s.timeS = timeAt(r, near.along);
  }
  option.tetRange = [ra ? ra.totalM : 0, (ra ? ra.totalM : 0) + mid.totalM];
  return r;
}

// Approche (facultative) + tronçon de trace + retour (facultatif), avec les annonces aux jonctions.
function joinTet(r1, r2, r3, traceName) {
  const name = traceName || 'TET';
  const parts = [], labels = [];
  if (r1) { parts.push(r1); labels.push(null); }
  parts.push(r2); labels.push(r1 ? `Prenez la trace « ${name} ».` : null);
  if (r3) { parts.push(r3); labels.push(`Fin du tronçon « ${name} », retour par la route.`); }
  return joinRoutes(parts, labels);
}
