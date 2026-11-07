// Test de bout en bout du générateur sur le monde simulé (node tests/test-planner.mjs)
import { installMock } from './mock-world.js';
import { setRateGap } from '../js/services.js';
import { planRoutes, abTargetMinutes, routeWithStops } from '../js/planner.js';
import { decodePolyline, encodePolyline, haversine } from '../js/geo.js';

const t0 = Date.now();
const world = installMock(globalThis, { latency: 0 });
setRateGap(0);
console.log('monde :', world.nodes.length, 'nœuds,', world.edges.length, 'routes,', world.interest.length, 'POI découverte,', world.stopsPois.length, 'POI pauses', (Date.now() - t0) + 'ms');

// polyline aller-retour
const pts = [[45.1, 7.2], [45.12345, 7.23456], [45.2, 7.1]];
const back = decodePolyline(encodePolyline(pts));
console.assert(back.every((p, i) => Math.abs(p[0] - pts[i][0]) < 1e-6), 'polyline');

// règle de durée A→B
console.log('A→B fast 70, wish 120, max 240 :', [0, 0.25, 0.5, 0.75, 1].map((d) => abTargetMinutes(70, 120, 240, d).toFixed(0)).join(' / '));

const settings = {
  fullTankKm: 280, safetyKm: 30, pauseEveryMin: 60, pauseDurationMin: 20,
  pauseTypes: { cafe: true, restaurant: true, viewpoint: true, picnic: false },
  avoid: { highways: true, tolls: true, ferries: false, unpaved: true },
};
const start = world.places[2].p; // Avigliana (simulé)

async function runLoop(durationMin, discovery, fuelKm) {
  const t = Date.now();
  const res = await planRoutes({ mode: 'loop', start, durationMin, discovery, fuelKm, settings, departure: new Date('2026-11-08T09:30:00') }, {});
  console.log(`\nBOUCLE ${durationMin} min, découverte ${discovery * 100}%, autonomie ${fuelKm} km → ${res.options.length} parcours (${Date.now() - t} ms, ${globalThis.__mockStats.valhalla} appels routage)`);
  for (const o of res.options) {
    const m = o.metrics;
    console.log(` - ${o.name} [${o.badge?.label || '-'}] ${(o.route.timeS / 60).toFixed(0)} min, ${(o.route.totalM / 1000).toFixed(0)} km, virages ${m.curvRating}/5 (${m.degPerKm.toFixed(0)}°/km), panoramas ${m.panoramaCount}, retour sur ses pas ${(m.overlap * 100).toFixed(0)}%`);
    for (const s of o.stops) console.log(`     · ${s.label} — ${s.name} à ${(s.timeS / 60).toFixed(0)} min, km ${(s.along / 1000).toFixed(0)}, ${s.distFromRoute} m du parcours`);
    if (o.fuelWarning) console.log('     ! ' + o.fuelWarning.message);
  }
  return res;
}

const r1 = await runLoop(180, 0.6, 140);
await runLoop(90, 0, 200);
await runLoop(240, 1, 60);

// A→B
const A = world.places[0].p, B = world.places[1].p;
for (const d of [0, 0.5, 1]) {
  const t = Date.now();
  const res = await planRoutes({ mode: 'ab', start: A, end: B, wishMin: 120, maxMin: 240, discovery: d, fuelKm: 200, settings }, {
    onProgress: (e) => { if (e.phase === 'reference-done') console.log(`\nA→B découverte ${d * 100}% : le plus rapide ${(e.fastS / 60).toFixed(0)} min, visé ${(e.targetS / 60).toFixed(0)} min`); },
  });
  console.log(` → ${res.options.length} parcours (${Date.now() - t} ms)`);
  for (const o of res.options) console.log(` - ${o.name} [${o.badge?.label || '-'}] ${(o.route.timeS / 60).toFixed(0)} min, ${(o.route.totalM / 1000).toFixed(0)} km, virages ${o.metrics.curvRating}/5, pauses ${o.stops.length}`);
}

// Recalcul avec pauses
const opt = r1.options[0];
const before = opt.route.timeS;
const r2 = await routeWithStops(opt, settings);
console.log(`\nAvec pauses : ${(before / 60).toFixed(0)} → ${(r2.timeS / 60).toFixed(0)} min, ${r2.legs.length} étapes ; pauses aux km ${opt.stops.map((s) => (s.along / 1000).toFixed(0)).join(', ')}`);
console.log('manœuvres :', r2.maneuvers.length, '— exemple :', r2.maneuvers.slice(0, 3).map((m) => m.instruction).join(' | '));
console.log('\nOK en', ((Date.now() - t0) / 1000).toFixed(1), 's');
