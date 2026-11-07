// Monde simulé pour les tests hors ligne : un réseau routier artificiel qui répond
// comme Valhalla, Overpass et Photon. Chargé seulement avec ?mock=1 (jamais en usage normal).
import { haversine, bearing, destination, angleDiff, encodePolyline, rng } from '../js/geo.js';

const CENTER = [45.07, 7.40];
const N = 21;            // nœuds par côté
const SPACING = 8000;    // m

const PASS_NAMES = ['del Lys', 'della Lombarda', 'Basset', 'delle Finestre', 'del Sestriere', 'di Tenda', 'della Maddalena', 'Fauniera', 'del Nivolet', 'San Carlo', 'del Moncenisio', 'Braida', 'della Ciabra', 'del Prete', 'Bercia'];
const LAKE_NAMES = ['Lago di Avigliana', 'Lago Nero', 'Lago di Viverone', 'Lago della Rossa', 'Lago di Ceresole', 'Lago Verde', 'Lago di Candia', 'Lago Piccolo', 'Lago del Moncenisio', 'Lago Malciaussia', 'Lago di Meugliano', 'Lago Sirio'];
const CASTLE_NAMES = ['Castello di Fenis', 'Rocca di Cavour', 'Forte di Exilles', 'Castello di Masino', 'Sacra di San Michele', 'Castello di Rivoli'];
const CAFE_NAMES = ['Bar Alpino', 'Caffè della Piazza', 'Bar del Ponte', 'Caffè Centrale', 'Bar Sport', 'Rifugio Belvedere', 'Bar Stella', 'Caffè del Borgo'];
const RESTO_NAMES = ['Trattoria del Lago', 'Osteria del Colle', 'Ristorante La Baita', 'Trattoria da Gino', 'Agriturismo Le Vigne'];
const FUEL_BRANDS = ['Eni', 'Q8', 'IP', 'Tamoil', 'Esso'];
const PLACES = [
  { name: 'Susa', gx: 3, gy: 12 },
  { name: 'Pinerolo', gx: 8, gy: 4 },
  { name: 'Avigliana', gx: 9, gy: 11 },
  { name: 'Lanzo Torinese', gx: 12, gy: 15 },
  { name: 'Viù', gx: 7, gy: 16 },
];

function gridPoint(gx, gy) {
  const off = ((N - 1) / 2) * SPACING;
  const p1 = destination(CENTER, 90, gx * SPACING - off);
  return destination(p1, 0, gy * SPACING - off);
}

export function buildWorld(seed = 42) {
  const rand = rng(seed);
  const nodes = [];
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const base = gridPoint(gx, gy);
    const p = destination(destination(base, 90, (rand() - 0.5) * 4000), 0, (rand() - 0.5) * 4000);
    nodes.push({ id: nodes.length, p, gx, gy, adj: [] });
  }
  const edges = [];
  const addEdge = (a, b) => {
    const r = rand();
    const cls = r < 0.28 ? 'twisty' : r < 0.78 ? 'country' : 'main';
    const pa = nodes[a].p, pb = nodes[b].p;
    const D = haversine(pa, pb), brg = bearing(pa, pb);
    const amp = cls === 'twisty' ? 120 + rand() * 220 : cls === 'country' ? 30 + rand() * 120 : 5 + rand() * 30;
    const lambda = cls === 'twisty' ? 450 + rand() * 800 : cls === 'country' ? 1500 + rand() * 2000 : 4000;
    const phase = rand() * Math.PI * 2;
    const pts = [];
    const steps = Math.max(2, Math.round(D / (cls === 'twisty' ? 40 : 90)));
    for (let i = 0; i <= steps; i++) {
      const s = (i / steps) * D;
      const base = destination(pa, brg, s);
      const off = amp * Math.sin((2 * Math.PI * s) / lambda + phase) * Math.sin((Math.PI * s) / D);
      pts.push(destination(base, brg + 90, off));
    }
    pts[0] = pa; pts[pts.length - 1] = pb;
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1], pts[i]);
    const speed = cls === 'twisty' ? 38 : cls === 'country' ? 62 : 82;
    const e = { id: edges.length, a, b, pts, len, time: len / (speed / 3.6), cls,
      name: (cls === 'main' ? 'SS' : 'SP') + (edges.length + 1) };
    edges.push(e);
    nodes[a].adj.push(e.id); nodes[b].adj.push(e.id);
  };
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    const id = gy * N + gx;
    if (gx < N - 1 && rand() > 0.08) addEdge(id, id + 1);
    if (gy < N - 1 && rand() > 0.08) addEdge(id, id + N);
    if (gx < N - 1 && gy < N - 1 && rand() < 0.25) addEdge(id, id + N + 1);
  }

  // Points d'intérêt.
  let osmId = 1000;
  const interest = [];
  const stopsPois = [];
  const onEdge = (e, f, sideOff) => {
    const idx = Math.min(e.pts.length - 2, Math.floor(f * (e.pts.length - 1)));
    const brg = bearing(e.pts[idx], e.pts[idx + 1]);
    return destination(e.pts[idx], brg + 90, sideOff);
  };
  let passI = 0;
  for (const e of edges) {
    if (e.cls === 'twisty') {
      if (rand() < 0.35) {
        const p = onEdge(e, rand(), 60 + rand() * 100);
        interest.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { tourism: 'viewpoint', ...(rand() < 0.4 ? { name: 'Belvedere ' + e.name } : {}) } });
      }
      if (rand() < 0.16 && passI < PASS_NAMES.length * 3) {
        const p = onEdge(e, 0.5, 0);
        const nm = 'Colle ' + PASS_NAMES[passI % PASS_NAMES.length] + (passI >= PASS_NAMES.length ? ' ' + (Math.floor(passI / PASS_NAMES.length) + 1) : '');
        passI++;
        interest.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { mountain_pass: 'yes', name: nm, ele: String(900 + Math.round(rand() * 1400)) } });
      }
    }
    // Cafés, restaurants, stations.
    const km = e.len / 1000;
    const nCafe = Math.floor(km / 7 + rand());
    for (let i = 0; i < nCafe; i++) {
      const p = onEdge(e, rand(), 30 + rand() * 170);
      stopsPois.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { amenity: rand() < 0.75 ? 'cafe' : 'bar', name: CAFE_NAMES[osmId % CAFE_NAMES.length] } });
    }
    if (rand() < km / 14) {
      const p = onEdge(e, rand(), 40 + rand() * 150);
      stopsPois.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { amenity: 'restaurant', name: RESTO_NAMES[osmId % RESTO_NAMES.length] } });
    }
    if (e.cls !== 'twisty' && rand() < km / 26) {
      const p = onEdge(e, rand(), 20 + rand() * 60);
      stopsPois.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { amenity: 'fuel', brand: FUEL_BRANDS[osmId % FUEL_BRANDS.length] } });
    }
    if (rand() < 0.05) {
      const p = onEdge(e, rand(), 50 + rand() * 120);
      stopsPois.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { tourism: 'picnic_site' } });
    }
  }
  for (let i = 0; i < LAKE_NAMES.length; i++) {
    const n = nodes[Math.floor(rand() * nodes.length)];
    const p = destination(n.p, rand() * 360, 600 + rand() * 900);
    interest.push({ type: 'way', id: osmId++, center: { lat: p[0], lon: p[1] }, tags: { natural: 'water', water: 'lake', name: LAKE_NAMES[i] } });
  }
  for (let i = 0; i < CASTLE_NAMES.length; i++) {
    const e = edges[Math.floor(rand() * edges.length)];
    const p = onEdge(e, rand(), 150);
    interest.push({ type: 'node', id: osmId++, lat: p[0], lon: p[1], tags: { historic: 'castle', name: CASTLE_NAMES[i] } });
  }
  const places = PLACES.map((pl) => ({ name: pl.name, p: nodes[pl.gy * N + pl.gx].p }));
  return { nodes, edges, interest, stopsPois, places, center: CENTER };
}

// --- Routage (Dijkstra) -----------------------------------------------------

function snap(world, p) {
  let best = { d: Infinity };
  for (const e of world.edges) {
    // pré-filtre grossier
    if (haversine(p, e.pts[Math.floor(e.pts.length / 2)]) > e.len / 2 + 12000) continue;
    for (let i = 0; i < e.pts.length; i++) {
      const d = haversine(p, e.pts[i]);
      if (d < best.d) best = { d, e, i };
    }
  }
  return best;
}

function subLen(pts, i0, i1) {
  let s = 0;
  for (let i = i0 + 1; i <= i1; i++) s += haversine(pts[i - 1], pts[i]);
  return s;
}

// Plus court chemin (en temps) entre deux points accrochés au réseau.
function shortest(world, s, t) {
  const { nodes, edges } = world;
  // Arcs virtuels depuis/vers les points accrochés.
  const startArcs = []; // vers les nœuds a et b de l'arête de départ
  const se = s.e, te = t.e;
  const mk = (e, fromIdx, toIdx) => {
    const pts = fromIdx <= toIdx ? e.pts.slice(fromIdx, toIdx + 1) : e.pts.slice(toIdx, fromIdx + 1).reverse();
    const len = subLen(pts, 0, pts.length - 1);
    return { pts, len, time: len * e.time / e.len, name: e.name };
  };
  startArcs.push({ node: se.a, arc: mk(se, s.i, 0) });
  startArcs.push({ node: se.b, arc: mk(se, s.i, se.pts.length - 1) });
  const endArcs = new Map();
  endArcs.set(te.a, mk(te, 0, t.i));
  endArcs.set(te.b, mk(te, te.pts.length - 1, t.i));

  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Array(nodes.length).fill(null);
  const done = new Uint8Array(nodes.length);
  const queue = [];
  for (const sa of startArcs) {
    if (sa.arc.time < dist[sa.node]) { dist[sa.node] = sa.arc.time; prev[sa.node] = { arc: sa.arc, from: -1 }; queue.push(sa.node); }
  }
  let best = Infinity, bestEnd = null;
  if (se === te) {
    const direct = mk(se, s.i, t.i);
    best = direct.time; bestEnd = { direct };
  }
  while (queue.length) {
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if (dist[queue[i]] < dist[queue[bi]]) bi = i;
    const u = queue.splice(bi, 1)[0];
    if (done[u]) continue;
    done[u] = 1;
    if (dist[u] >= best) break;
    if (endArcs.has(u)) {
      const tt = dist[u] + endArcs.get(u).time;
      if (tt < best) { best = tt; bestEnd = { node: u, arc: endArcs.get(u) }; }
    }
    for (const eid of nodes[u].adj) {
      const e = edges[eid];
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + e.time;
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = { arc: { pts: e.a === u ? e.pts : e.pts.slice().reverse(), len: e.len, time: e.time, name: e.name }, from: u };
        queue.push(v);
      }
    }
  }
  if (!bestEnd) return null;
  if (bestEnd.direct) return [bestEnd.direct];
  const arcs = [bestEnd.arc];
  let cur = bestEnd.node;
  while (cur !== -1 && prev[cur]) { arcs.unshift(prev[cur].arc); cur = prev[cur].from; }
  return arcs;
}

function turnType(delta) {
  const a = Math.abs(delta);
  if (a < 22) return 8;
  const right = delta > 0;
  if (a < 50) return right ? 9 : 16;
  if (a < 125) return right ? 10 : 15;
  return right ? 11 : 14;
}
const TURN_TEXT = { 8: 'Continuez', 9: 'Serrez à droite', 10: 'Tournez à droite', 11: 'Tournez franchement à droite', 14: 'Tournez franchement à gauche', 15: 'Tournez à gauche', 16: 'Serrez à gauche' };

function arcBearing(pts, fromEnd) {
  if (pts.length < 2) return 0;
  if (fromEnd) {
    let i = pts.length - 1, d = 0;
    while (i > 0 && d < 120) { d += haversine(pts[i - 1], pts[i]); i--; }
    return bearing(pts[i], pts[pts.length - 1]);
  }
  let i = 0, d = 0;
  while (i < pts.length - 1 && d < 120) { d += haversine(pts[i], pts[i + 1]); i++; }
  return bearing(pts[0], pts[i]);
}

export function mockRoute(world, req) {
  const locs = req.locations;
  const snaps = locs.map((l) => snap(world, [l.lat, l.lon]));
  if (snaps.some((s) => !s.e || s.d > 15000)) return { status: 400, body: { error_code: 171, error: 'No suitable edges near location', status_code: 400 } };
  const legs = [];
  let legArcs = [];
  const legLocs = [];
  for (let k = 0; k < locs.length - 1; k++) {
    const arcs = shortest(world, snaps[k], snaps[k + 1]);
    if (!arcs) return { status: 400, body: { error_code: 442, error: 'No path could be found for input', status_code: 400 } };
    legArcs.push(...arcs.filter((a) => a.pts.length > 1));
    const isBreak = (locs[k + 1].type || 'break') === 'break' || k + 1 === locs.length - 1;
    if (isBreak) { legs.push(legArcs); legArcs = []; legLocs.push(k + 1); }
  }
  let totalT = 0, totalL = 0;
  const outLegs = legs.map((arcs) => {
    const shape = [];
    const maneuvers = [];
    let curMan = null;
    const pushMan = (type, instr, name, idx) => {
      curMan = { type, instruction: instr, verbal_transition_alert_instruction: instr, verbal_pre_transition_instruction: instr,
        street_names: name ? [name] : [], time: 0, length: 0, begin_shape_index: idx, end_shape_index: idx, travel_mode: 'drive', travel_type: 'motorcycle' };
      maneuvers.push(curMan);
    };
    arcs.forEach((a, ai) => {
      const startIdx = shape.length === 0 ? 0 : shape.length - 1;
      if (ai === 0) {
        pushMan(1, `Partez sur la ${a.name}.`, a.name, 0);
      } else {
        const prevA = arcs[ai - 1];
        const delta = angleDiff(arcBearing(prevA.pts, true), arcBearing(a.pts, false));
        const tt = turnType(delta);
        if (tt !== 8 || prevA.name !== a.name) {
          curMan.end_shape_index = startIdx;
          pushMan(tt, `${TURN_TEXT[tt]} sur la ${a.name}.`, a.name, startIdx);
        }
      }
      for (let i = shape.length === 0 ? 0 : 1; i < a.pts.length; i++) shape.push(a.pts[i]);
      curMan.time += a.time; curMan.length += a.len / 1000;
      curMan.end_shape_index = shape.length - 1;
      curMan.verbal_post_transition_instruction = `Continuez pendant ${Math.max(1, Math.round(curMan.length))} kilomètres.`;
    });
    pushMan(4, 'Vous êtes arrivé à destination.', '', shape.length - 1);
    const time = maneuvers.reduce((s, m) => s + m.time, 0);
    const length = maneuvers.reduce((s, m) => s + m.length, 0);
    totalT += time; totalL += length;
    maneuvers.forEach((m) => { m.time = +m.time.toFixed(3); m.length = +m.length.toFixed(3); });
    return { maneuvers, summary: { time, length }, shape: encodePolyline(shape, 6) };
  });
  return {
    status: 200,
    body: {
      trip: {
        locations: locs, legs: outLegs, status: 0, status_message: 'Found route between points', units: 'kilometers', language: 'fr-FR',
        summary: { time: totalT, length: totalL, has_highway: false, has_toll: false, has_ferry: false },
      },
      id: req.id,
    },
  };
}

// --- Interception de fetch ---------------------------------------------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

export function installMock(target = globalThis, { seed = 42, latency = 60, log = null } = {}) {
  const world = buildWorld(seed);
  const realFetch = target.fetch.bind(target);
  const stats = { valhalla: 0, overpass: 0, photon: 0 };
  target.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const wait = () => new Promise((r) => setTimeout(r, latency * (0.5 + Math.random())));
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (url.startsWith('https://valhalla1.openstreetmap.de/route')) {
      stats.valhalla++;
      await wait();
      const req = JSON.parse(new URL(url).searchParams.get('json'));
      const res = mockRoute(world, req);
      if (log) log('valhalla', req.locations.length, res.status);
      return json(res.body, res.status);
    }
    if (url.includes('/api/interpreter')) {
      stats.overpass++;
      await wait();
      const body = decodeURIComponent(String(init.body || '').replace(/^data=/, ''));
      if (body.includes('mountain_pass')) return json({ elements: world.interest });
      if (body.includes('amenity')) return json({ elements: world.stopsPois });
      return json({ elements: [] });
    }
    if (url.startsWith('https://photon.komoot.io')) {
      stats.photon++;
      await wait();
      const q = (new URL(url).searchParams.get('q') || '').toLowerCase();
      const feats = world.places.filter((p) => p.name.toLowerCase().includes(q.slice(0, 3)) || q.length < 2)
        .map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.p[1], p.p[0]] }, properties: { name: p.name, state: 'Piemonte', country: 'Italia' } }));
      return json({ type: 'FeatureCollection', features: feats.length ? feats : world.places.slice(0, 3).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.p[1], p.p[0]] }, properties: { name: p.name, country: 'Italia' } })) });
    }
    return realFetch(input, init);
  };
  target.__mockWorld = world;
  target.__mockStats = stats;
  return world;
}
