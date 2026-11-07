// Tout-terrain : difficulté, légalité (indicative) et alternance piste / route.
import { cellKey, haversine, resample, cumulative } from './geo.js';

export const LEVELS = {
  beginner: { label: 'Débutant', maxGrade: 2 },
  intermediate: { label: 'Intermédiaire', maxGrade: 4 },
  expert: { label: 'Confirmé', maxGrade: 5 },
};

// Avec un trail lourd, on reste un cran en dessous (sauf débutant, déjà au plus facile).
export function maxGradeFor(level, bikeType) {
  const g = (LEVELS[level] || LEVELS.intermediate).maxGrade;
  return bikeType === 'heavy' && level !== 'beginner' ? g - 1 : g;
}

// Profil Valhalla : moto avec le réglage « aventure » (use_trails) selon la part de pistes visée.
export function offroadProfile(settings, share) {
  const s = Math.max(0.05, Math.min(0.95, share));
  return {
    costing: 'motorcycle',
    options: {
      use_trails: +(0.25 + 0.75 * s).toFixed(2),
      use_highways: 0,
      use_tolls: settings.avoid?.tolls ? 0 : 0.5,
      use_ferry: settings.avoid?.ferries ? 0 : 0.5,
      exclude_unpaved: false,
    },
  };
}

const VALHALLA_UNPAVED = new Set(['compacted', 'dirt', 'gravel', 'path', 'impassable']);
const OFFROAD_USES = new Set(['track', 'path', 'mountain_bike', 'footway', 'bridleway']);

export function isOffroadEdge(e) {
  return OFFROAD_USES.has(e.use) || VALHALLA_UNPAVED.has(e.surface);
}

const SMOOTH = { excellent: 1, good: 1, intermediate: 2, bad: 3, very_bad: 4, horrible: 5, very_horrible: 5, impassable: 6 };
const SURF = {
  asphalt: 1, paved: 1, concrete: 1, paving_stones: 1, sett: 2, compacted: 2, fine_gravel: 2,
  gravel: 3, unpaved: 3, pebblestone: 3, dirt: 3, earth: 3, ground: 3, grass: 4, mud: 5, sand: 4, rock: 5, stone: 4,
};
const SAC = { hiking: 4, mountain_hiking: 5, demanding_mountain_hiking: 6, alpine_hiking: 6, demanding_alpine_hiking: 6, difficult_alpine_hiking: 6 };

// Difficulté de 1 (piste roulante) à 5 (très technique) ; 6 = impraticable.
export function gradeOf(tags = {}, edge = {}) {
  const known = [];
  const tt = /^grade([1-5])$/.exec(tags.tracktype || '');
  if (tt) known.push(+tt[1]);
  if (SMOOTH[tags.smoothness]) known.push(SMOOTH[tags.smoothness]);
  if (SAC[tags.sac_scale]) known.push(SAC[tags.sac_scale]);
  if (known.length) return { grade: Math.max(...known), known: true };
  if (SURF[tags.surface]) return { grade: SURF[tags.surface], known: true };
  if (edge.surface === 'compacted') return { grade: 2, known: false };
  if (edge.surface === 'path') return { grade: 4, known: false };
  if (edge.surface === 'impassable') return { grade: 6, known: false };
  return { grade: 3, known: false }; // piste sans information : on suppose moyenne
}

const ALLOW = new Set(['yes', 'permissive', 'designated', 'official']);
const FORBID = new Set(['no', 'private', 'forestry', 'agricultural', 'delivery', 'military', 'use_sidepath']);

// Légalité indicative d'une voie : 'green' (autorisée ou TET), 'orange' (inconnue), 'red' (interdite).
export function legalityOf(tags = {}, { onTet = false, offroad = true } = {}) {
  for (const k of ['motorcycle', 'motor_vehicle', 'vehicle', 'access']) {
    const v = tags[k];
    if (!v) continue;
    if (FORBID.has(v)) return onTet ? 'orange' : 'red';
    if (ALLOW.has(v)) return 'green';
    return 'orange'; // destination, customers, conditionnel…
  }
  if (onTet) return 'green';
  return offroad ? 'orange' : 'green';
}

// Vitesse réaliste sur piste selon la difficulté (km/h), pour estimer les sections lentes.
const GRADE_SPEED = { 1: 40, 2: 32, 3: 24, 4: 16, 5: 10, 6: 6 };

// Index des traces GPX (TET…) pour savoir si une voie est sur le TET.
export function tetIndex(traces) {
  const set = new Set();
  for (const t of traces) {
    const cum = cumulative(t.points);
    for (const p of resample(t.points, cum, 25)) set.add(cellKey(p, 50));
  }
  return set;
}

function nearTet(index, p) {
  if (!index || !index.size) return false;
  const [x, y] = cellKey(p, 50).split(':').map(Number);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (index.has((x + dx) + ':' + (y + dy))) return true;
  return false;
}

/*
  edges : sortie de traceEdges (dans l'ordre du parcours) :
    { way_id, length (km), surface, use, road_class, speed (km/h), mid: [lat, lon] }
  tagsById : Map(way_id → tags OSM)
  Renvoie la synthèse tout-terrain du parcours.
*/
export function analyzeOffroad(edges, tagsById, tet, { maxGrade = 4, maxSlowMin = 20 } = {}) {
  const segs = [];
  let totalKm = 0, offKm = 0;
  const legal = { green: 0, orange: 0, red: 0 };
  const gradeKm = {};
  let maxG = 0, maxGLen = 0;
  let extraMin = 0; // temps en plus sur piste par rapport à l'estimation du moteur d'itinéraires
  let tetKm = 0;
  for (const e of edges) {
    const km = e.length || 0;
    const off = isOffroadEdge(e);
    const tags = tagsById.get(e.way_id) || {};
    const onTet = e.mid ? nearTet(tet, e.mid) : false;
    if (onTet) tetKm += km;
    let grade = 0, lg = 'green', speed = e.speed || 50;
    if (off) {
      const g = gradeOf(tags, e);
      grade = g.grade;
      lg = legalityOf(tags, { onTet, offroad: true });
      const routerMin = km / Math.max(5, e.speed || 30) * 60;
      speed = Math.min(speed || 99, GRADE_SPEED[grade] || 20);
      extraMin += Math.max(0, km / speed * 60 - routerMin);
      offKm += km;
      legal[lg] += km;
      gradeKm[grade] = (gradeKm[grade] || 0) + km;
    } else {
      lg = legalityOf(tags, { onTet, offroad: false });
      if (lg === 'red') legal.red += km;
    }
    totalKm += km;
    const min = speed > 0 ? (km / speed) * 60 : 0;
    const last = segs[segs.length - 1];
    if (last && last.off === off && (!off || last.grade === grade)) {
      last.km += km; last.min += min; if (onTet) last.tet = true;
    } else {
      segs.push({ off, km, min, grade, legal: lg, tet: onTet, startKm: totalKm - km });
    }
  }
  // Difficulté max : on ignore les tout petits bouts (< 150 m) au-dessus du reste.
  for (const s of segs) if (s.off && s.km >= 0.15 && s.grade > maxG) { maxG = s.grade; maxGLen = s.km; }
  // Sections lentes : suites de pistes, tant qu'on ne roule pas au moins 3 km sur route entre elles.
  let longestSlow = 0, cur = 0, gapKm = 0, stretches = 0;
  for (const s of segs) {
    if (s.off) {
      if (cur === 0) stretches++;
      cur += s.min; gapKm = 0;
      if (cur > longestSlow) longestSlow = cur;
    } else {
      gapKm += s.km;
      if (gapKm >= 3) cur = 0; else cur += s.min;
    }
  }
  const tooHard = segs.some((s) => s.off && s.km >= 0.15 && s.grade > maxGrade);
  return {
    totalKm, offKm, share: totalKm ? offKm / totalKm : 0,
    legal, gradeKm, maxGrade: maxG, maxGradeLen: maxGLen, tooHard,
    longestSlowMin: longestSlow, slowStretches: stretches,
    tetKm,
    segments: segs.filter((s) => s.km > 0.05),
    overheat: longestSlow > maxSlowMin,
    extraMin,
  };
}

// Note tout-terrain à ajouter au score du parcours.
export function offroadScore(o, ctx) {
  let s = 0;
  s -= Math.abs(o.share - ctx.share) * 2.2;                       // proche de la part de pistes visée
  s -= Math.max(0, o.longestSlowMin - ctx.maxSlowMin) / 6;        // alternance piste / route
  s += o.offKm ? (o.legal.green / o.offKm) * 0.4 : 0;              // préfère le vert
  s += Math.min(1, o.tetKm / 20) * 0.4;                            // bonus TET
  return s;
}

// Mots pour l'interface.
export function gradeLabel(g) {
  return ['', 'roulante', 'facile', 'moyenne', 'difficile', 'très difficile', 'impraticable'][g] || 'inconnue';
}
