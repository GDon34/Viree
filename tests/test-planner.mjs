// Test de bout en bout du générateur sur le monde simulé (node tests/test-planner.mjs)
import { installMock } from './mock-world.js';
import { setRateGap } from '../js/services.js';
import { PlanSession, abTargetMinutes, routeWithStops } from '../js/planner.js';
import { decodePolyline, encodePolyline } from '../js/geo.js';
import { cellsOfShape } from '../js/store.js';

const t0 = Date.now();
const world = installMock(globalThis, { latency: 0 });
setRateGap(0);
console.log('monde :', world.nodes.length, 'nœuds,', world.edges.length, 'routes,', world.interest.length, 'POI découverte,', world.stopsPois.length, 'POI pauses');

const pts = [[45.1, 7.2], [45.12345, 7.23456], [45.2, 7.1]];
console.assert(decodePolyline(encodePolyline(pts)).every((p, i) => Math.abs(p[0] - pts[i][0]) < 1e-6), 'polyline');
console.log('A→B fast 70, wish 120, max 240 :', [0, 0.25, 0.5, 0.75, 1].map((d) => abTargetMinutes(70, 120, 240, d).toFixed(0)).join(' / '));

const settings = {
  fullTankKm: 280, safetyKm: 30, pauseEveryMin: 60, pauseDurationMin: 20,
  pauseTypes: { cafe: true, restaurant: true, viewpoint: true, picnic: false },
  avoid: { highways: true, tolls: true, ferries: false, unpaved: true },
};
const start = world.places[2].p;

function run(params, memory = {}, label = '') {
  return new Promise((resolve) => {
    const steps = [];
    let firstAt = null;
    const t = Date.now();
    const s = new PlanSession(params, {
      onStep: (x) => steps.push(x),
      onRoute: () => { if (!firstAt) firstAt = Date.now() - t; },
      onDone: (info) => resolve({ s, info, steps, firstAt, ms: Date.now() - t }),
      onError: (e) => { console.log('ERREUR', e.message); resolve({ s, info: null, steps }); },
    }, memory);
    s.start();
  });
}

const base = { mode: 'loop', start, durationMin: 180, discovery: 0.6, fuelKm: 140, settings, departure: new Date('2026-11-08T09:30:00') };
const r1 = await run(base);
console.log(`\nBOUCLE 3 h, 60 % → ${r1.info.total} parcours, ${r1.s.stats.computed} calculés (${r1.ms} ms), stats`, JSON.stringify(r1.info.stats), 'profils', JSON.stringify(globalThis.__mockStats.costings));
console.log('  étapes (extraits) :', r1.steps.slice(0, 4).concat(r1.steps.slice(-2)));
for (const o of r1.s.options) {
  console.log(` - ${o.name} [${o.badge?.label || '-'}]${o.best ? ' ★' : ''} ${(o.route.timeS / 60).toFixed(0)} min, ${(o.route.totalM / 1000).toFixed(0)} km, virages ${o.metrics.curvRating}/5, pauses ${o.stops.length}${o.fuelWarning ? ' ! ' + o.fuelWarning.message : ''}`);
}
// Charger davantage
const before = r1.s.options.length;
await new Promise((res) => { r1.s.hooks.onDone = (info) => { console.log(`\nPLUS → +${info.added} (total ${info.total})`); res(); }; r1.s.more(); });

// Exclusion : on « roule » les 8 premiers, puis on relance la même recherche
const exclusions = r1.s.options.map((o) => ({ why: 'ride', cells: cellsOfShape(o.route.shape) }));
const r2 = await run(base, { exclusions });
console.log(`\nMÊME RECHERCHE après avoir roulé ${exclusions.length} parcours → ${r2.info.total} nouveaux, écartés car déjà faits : ${r2.info.stats.rejectedRide}`);

// Goûts : préférence forte pour les virages
const r3 = await run(base, { prefs: { curv: 1, pano: 0, lake: 0, calm: -0.5 } });
const best = r3.s.options.find((o) => o.best);
console.log(`\nAVEC GOÛT « VIRAGES » → meilleur : ${best.name} (${best.metrics.degPerKm.toFixed(0)}°/km) ; moyenne liste ${(r3.s.options.reduce((a, o) => a + o.metrics.degPerKm, 0) / r3.s.options.length).toFixed(0)}°/km`);

// A→B
const A = world.places[0].p, B = world.places[1].p;
for (const d of [0, 0.5, 1]) {
  const r = await run({ mode: 'ab', start: A, end: B, wishMin: 120, maxMin: 240, discovery: d, fuelKm: 200, settings });
  console.log(`\nA→B ${d * 100} % : rapide ${(r.s.ctx.fastS / 60).toFixed(0)} min, visé ${(r.s.ctx.targetS / 60).toFixed(0)} min → ${r.info.total} parcours :`, r.s.options.map((o) => `${o.name} ${(o.route.timeS / 60).toFixed(0)} min`).join(' | '));
}

import { retraceInfo, hasUTurn } from '../js/planner.js';
import { roadClassShare } from '../js/services.js';
const bad = r1.s.options.filter((o) => hasUTurn(retraceInfo(o.route, 'loop')));
console.log('\nparcours proposés avec demi-tour :', bad.length);
const share = await roadClassShare(r1.s.options[0].route.shape);
console.log('part de petites routes (simulée) :', Math.round(share.small * 100) + ' %', JSON.stringify(Object.fromEntries(Object.entries(share.byClass).map(([k, v]) => [k, Math.round(v)]))));
const opt = r1.s.options[0];
const r4 = await routeWithStops(opt, settings);
console.log(`\nAvec pauses : ${r4.legs.length} étapes ; ${r4.maneuvers.length} manœuvres`);
console.log('\nOK en', ((Date.now() - t0) / 1000).toFixed(1), 's');
