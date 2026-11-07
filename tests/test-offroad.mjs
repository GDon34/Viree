// Tests du mode tout-terrain sur le monde simulé (node tests/test-offroad.mjs)
import { installMock, mockTetGpx } from './mock-world.js';
import { setRateGap } from '../js/services.js';
import { PlanSession, retraceInfo, hasUTurn, routeWithStops } from '../js/planner.js';
import { gradeOf, legalityOf, maxGradeFor, analyzeOffroad } from '../js/offroad.js';
import { cumulative } from '../js/geo.js';

const world = installMock(globalThis, { latency: 0 });
setRateGap(0);

// Unités : difficulté et légalité
console.log('grades :', [
  gradeOf({ tracktype: 'grade2' }), gradeOf({ tracktype: 'grade2', smoothness: 'very_bad' }), gradeOf({ surface: 'gravel' }), gradeOf({}, { surface: 'compacted' }), gradeOf({}),
].map((g) => g.grade + (g.known ? '' : '?')).join(' '));
console.log('légalité :', [
  legalityOf({ motorcycle: 'yes', access: 'no' }), legalityOf({ motor_vehicle: 'agricultural' }), legalityOf({}), legalityOf({}, { onTet: true }), legalityOf({ access: 'private' }, { onTet: true }),
].join(' '));
console.log('niveau max (léger / lourd) :', ['beginner', 'intermediate', 'expert'].map((l) => maxGradeFor(l, 'light') + '/' + maxGradeFor(l, 'heavy')).join('  '));

// Alternance : 3 pistes de 15 min séparées par 1 km de route = une seule section lente de ~45 min
const edges = [];
for (let k = 0; k < 3; k++) {
  edges.push({ way_id: 1, length: 6, surface: 'gravel', use: 'track', speed: 30 });
  edges.push({ way_id: 2, length: 1, surface: 'paved_smooth', use: 'road', speed: 60 });
}
const a1 = analyzeOffroad(edges, new Map([[1, { tracktype: 'grade3' }]]), null, { maxGrade: 4, maxSlowMin: 20 });
console.log(`alternance (pauses roulantes de 1 km) : section lente max ${a1.longestSlowMin.toFixed(0)} min, surchauffe ${a1.overheat}`);
edges.forEach((e) => { if (e.way_id === 2) e.length = 5; });
const a2 = analyzeOffroad(edges, new Map([[1, { tracktype: 'grade3' }]]), null, { maxGrade: 4, maxSlowMin: 20 });
console.log(`alternance (pauses roulantes de 5 km) : section lente max ${a2.longestSlowMin.toFixed(0)} min, surchauffe ${a2.overheat}`);

// TET simulé (sans DOMParser : on lit directement les points)
const gpx = mockTetGpx(world);
const pts = [...gpx.matchAll(/lat="([\d.]+)" lon="([\d.]+)"/g)].map((m) => [+m[1], +m[2]]);
const tet = { id: 't1', name: 'TET Italia (simulé)', points: pts, cum: cumulative(pts) };
console.log('trace TET :', pts.length, 'points,', (tet.cum[tet.cum.length - 1] / 1000).toFixed(0), 'km');

const settings = {
  fullTankKm: 280, safetyKm: 30, pauseEveryMin: 60, pauseDurationMin: 20,
  pauseTypes: { cafe: true, restaurant: true, viewpoint: true, picnic: false },
  avoid: { highways: true, tolls: true, ferries: false, unpaved: false },
};
const start = world.places[2].p;

function run(offroad, traces = [], from = start) {
  return new Promise((resolve) => {
    const s = new PlanSession({ mode: 'loop', start: from, durationMin: 180, discovery: 0.6, fuelKm: 200, settings, terrain: 'offroad', offroad }, {
      onDone: (info) => resolve({ s, info }),
      onError: (e) => { console.log('ERREUR', e.message); resolve({ s, info: null }); },
    }, { traces });
    s.start();
  });
}

for (const [label, off, traces, from] of [
  ['intermédiaire, 40 % de pistes, trail lourd', { level: 'intermediate', share: 0.4, bikeType: 'heavy', maxSlowMin: 20 }, []],
  ['débutant, 30 %, moto légère', { level: 'beginner', share: 0.3, bikeType: 'light', maxSlowMin: 20 }, []],
  ['confirmé, 60 %, avec TET', { level: 'expert', share: 0.6, bikeType: 'light', maxSlowMin: 25, useTet: true }, [tet], world.places[3].p],
]) {
  const t = Date.now();
  const { s, info } = await run(off, traces, from);
  console.log(`\nTOUT-TERRAIN ${label} → ${info.total} parcours (${((Date.now() - t) / 1000).toFixed(1)} s) ; écartés :`, JSON.stringify(info.stats));
  for (const o of s.options) {
    const x = o.offroad;
    const bad = hasUTurn(retraceInfo(o.route, 'loop'));
    if (o.tetRange) {
      const j = o.route.maneuvers.filter((m) => /trace/.test(m.instruction) || /TET/.test(m.instruction)).map((m) => `${(m.along / 1000).toFixed(1)} km « ${m.instruction} »`);
      console.log(`   tronçon TET de ${(o.tetRange[0] / 1000).toFixed(1)} à ${(o.tetRange[1] / 1000).toFixed(1)} km · annonces : ${j.join(' | ')}`);
    }
    console.log(` - ${o.name} [${o.badge?.label || '-'}] ${(o.route.timeS / 60).toFixed(0)} min, ${(o.route.totalM / 1000).toFixed(0)} km · pistes ${x.offKm?.toFixed(1)} km (${Math.round(x.share * 100)} %) · grade max ${x.maxGrade} (autorisé ${x.maxGradeAllowed}) · vert ${x.legal?.green.toFixed(1)} / orange ${x.legal?.orange.toFixed(1)} / rouge ${x.legal?.red.toFixed(1)} km · lent max ${x.longestSlowMin?.toFixed(0)} min · TET ${x.tetKm?.toFixed(1)} km${bad ? ' · DEMI-TOUR !' : ''}`);
  }
}

// Boucle par le TET : guidage vers les pauses, en gardant le tronçon de trace tel quel.
{
  const { s } = await run({ level: 'expert', share: 0.6, bikeType: 'light', maxSlowMin: 25, useTet: true }, [tet], world.places[3].p);
  const o = s.options.find((x) => x.tetRange);
  if (!o) console.log('\n(pas de boucle TET à tester)');
  else {
    await s.ensureStops(o);
    const before = o.tetRange[1] - o.tetRange[0];
    const r = await routeWithStops(o, settings);
    const after = o.tetRange[1] - o.tetRange[0];
    let jump = 0;
    for (let i = 1; i < r.shape.length; i++) jump = Math.max(jump, r.cum[i] - r.cum[i - 1]);
    console.log(`\nTET + pauses : ${o.stops.length} pauses (${o.stops.map((x) => (x.along / 1000).toFixed(0) + ' km').join(', ')}) · tronçon ${(before / 1000).toFixed(1)} → ${(after / 1000).toFixed(1)} km · ${r.legs.length} étapes · plus grand saut ${jump.toFixed(0)} m · demi-tour ${hasUTurn(retraceInfo(r, 'loop'))}`);
  }
}
