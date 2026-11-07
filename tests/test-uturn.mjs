// Tests unitaires du détecteur de demi-tours (node tests/test-uturn.mjs)
import { destination, bearing } from '../js/geo.js';
import { finalizeRoute } from '../js/services.js';
import { retraceInfo, hasUTurn } from '../js/planner.js';

const mk = (pts) => finalizeRoute({ shape: pts, maneuvers: [{ type: 1, time: 100, begin: 0, end: pts.length - 1 }], legs: [], timeS: 100 });
const line = (from, brg, len, step = 20) => { const out = []; for (let d = 0; d <= len; d += step) out.push(destination(from, brg, d)); return out; };
const A = [45.1, 7.4];

// 1. Aller-retour sur une impasse de 2 km au milieu d'un trajet
const a1 = line(A, 90, 10000);
const spur = line(a1[a1.length - 1], 0, 2000);
const back = spur.slice().reverse();
const a2 = line(a1[a1.length - 1], 90, 10000);
const r1 = mk([...a1, ...spur.slice(1), ...back.slice(1), ...a2.slice(1)]);
const i1 = retraceInfo(r1, 'ab');
console.log('impasse 2 km :', i1, '→ rejet', hasUTurn(i1));

// 2. Montée en lacets serrés (épingles, branches à 30 m l'une de l'autre) : ce n'est PAS un demi-tour
const hair = [A];
let p = A, h = 0;
for (let k = 0; k < 8; k++) {
  for (const q of line(p, h, 600).slice(1)) hair.push(q);
  p = hair[hair.length - 1];
  const centre = destination(p, 90, 15);
  for (let a = 15; a <= 180; a += 15) hair.push(destination(centre, (h === 0 ? 270 + a : 270 - a + 360) % 360, 15));
  p = hair[hair.length - 1];
  h = (h + 180) % 360;
}
const r2 = mk(hair);
const i2 = retraceInfo(r2, 'ab');
console.log('lacets en épingle :', i2, '→ rejet', hasUTurn(i2));

// 3. Boucle « sucette » : 3 km communs au départ et au retour (toléré jusqu'à 10 km)
const stem = line(A, 0, 3000);
const P = stem[stem.length - 1];
const loop = [];
let c = P;
for (const b of [90, 0, 270, 180]) { const seg = line(c, b, 10000); loop.push(...seg.slice(1)); c = seg[seg.length - 1]; }
const r3 = mk([...stem, ...loop, ...stem.slice().reverse().slice(1)]);
const i3 = retraceInfo(r3, 'loop');
console.log('boucle, 3 km communs :', i3, '→ rejet', hasUTurn(i3));
const i3b = retraceInfo(r3, 'ab');
console.log('même tracé en A→B :', i3b, '→ rejet', hasUTurn(i3b));
