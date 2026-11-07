// Accès aux services publics gratuits basés sur OpenStreetMap :
// - Valhalla (FOSSGIS) pour les itinéraires, limité à 1 requête par seconde
// - Overpass pour les points d'intérêt
// - Photon (komoot) pour la recherche d'adresses
import { decodePolyline, encodePolyline, cumulative, simplify, pointAlong, segmentAt } from './geo.js';

export const ENDPOINTS = {
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ],
  photon: 'https://photon.komoot.io/api/',
};

// Combine le signal d'annulation de l'utilisateur et un délai maximal.
function timed(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Délai dépassé', 'TimeoutError')), ms);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

export class AbortedError extends Error {
  constructor() { super('Recherche annulée'); this.name = 'AbortedError'; }
}

// File d'attente : une requête Valhalla à la fois, espacées d'au moins `gapMs`.
class RateQueue {
  constructor(gapMs) { this.gapMs = gapMs; this.last = 0; this.chain = Promise.resolve(); }
  run(fn) {
    const p = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { this.last = Date.now(); }
    });
    this.chain = p.catch(() => {});
    return p;
  }
}
const valhallaQueue = new RateQueue(1100);
// Pour les tests uniquement (le serveur public impose 1 requête par seconde).
export function setRateGap(ms) { valhallaQueue.gapMs = ms; }

export class RouteError extends Error {
  constructor(msg, code) { super(msg); this.name = 'RouteError'; this.code = code; }
}

// Options de coût moto à partir des réglages.
export function costingOptions(settings, extra = {}) {
  const a = settings.avoid || {};
  return {
    use_highways: a.highways ? 0 : 0.5,
    use_tolls: a.tolls ? 0 : 0.5,
    use_ferry: a.ferries ? 0 : 0.5,
    use_trails: 0,
    exclude_unpaved: !!a.unpaved,
    ...extra,
  };
}

// Profil d'itinéraire. « Petites routes » : profil scooter de Valhalla, qui sait éviter
// les routes principales (réglage use_primary), avec une vitesse max de moto de balade.
export function routingProfile(settings, discovery = 0.5) {
  if (settings.smallRoads === false) return { costing: 'motorcycle' };
  const strength = 0.4 + 0.6 * Math.max(0, Math.min(1, discovery));
  return {
    costing: 'motor_scooter',
    options: {
      top_speed: 90,
      use_primary: +(0.5 * (1 - strength)).toFixed(2),
      use_hills: 0.6,
      use_ferry: settings.avoid?.ferries ? 0 : 0.5,
      use_tolls: settings.avoid?.tolls ? 0 : 0.5,
      exclude_unpaved: !!settings.avoid?.unpaved,
    },
  };
}

// locations : [{lat, lon, type: 'break'|'through'|'via', heading?}]
// profile : { costing: 'motorcycle' | 'motor_scooter', options } (moto par défaut)
export async function route(locations, settings, { signal, costing = {}, alternates = 0, profile = null } = {}) {
  if (profile && profile.costing === 'motor_scooter') {
    try {
      const r = await routeOnce(locations, settings, { signal, costing, alternates, profile });
      return r;
    } catch (e) {
      // Repli sur le profil moto si le profil petites routes échoue (sauf réseau ou annulation).
      if (e instanceof AbortedError || (e instanceof RouteError && (e.code === 'network' || e.code === 429))) throw e;
    }
  }
  const moto = profile && profile.costing === 'motorcycle' ? profile : { costing: 'motorcycle' };
  return routeOnce(locations, settings, { signal, costing, alternates, profile: moto });
}

async function routeOnce(locations, settings, { signal, costing = {}, alternates = 0, profile }) {
  const costingName = profile?.costing || 'motorcycle';
  const costingOpts = costingName === 'motorcycle'
    ? { ...costingOptions(settings), ...(profile?.options || {}), ...costing }
    : { ...profile.options, ...costing };
  const body = {
    locations: locations.map((l) => {
      const o = { lat: +l.lat.toFixed(6), lon: +l.lon.toFixed(6), type: l.type || 'break' };
      if (l.heading != null) { o.heading = Math.round(l.heading); o.heading_tolerance = 60; }
      if (l.radius) o.radius = l.radius;
      if (l.filter) o.search_filter = l.filter;
      return o;
    }),
    costing: costingName,
    costing_options: { [costingName]: costingOpts },
    directions_options: { units: 'kilometers', language: 'fr-FR' },
    id: 'viree-gps',
  };
  if (alternates) body.alternates = alternates;
  const url = ENDPOINTS.valhalla + '?json=' + encodeURIComponent(JSON.stringify(body));
  return valhallaQueue.run(async () => {
    if (signal?.aborted) throw new AbortedError();
    let res;
    const t = timed(signal, 30000);
    let data = null;
    try {
      res = await fetch(url, { signal: t.signal });
      try { data = await res.json(); } catch { /* réponse non JSON */ }
    } catch (e) {
      if (signal?.aborted) throw new AbortedError();
      throw new RouteError('Serveur d\'itinéraires injoignable ou trop lent (réseau ?)', 'network');
    } finally { t.done(); }
    if (!res.ok || !data || !data.trip) {
      if (res.status === 429) throw new RouteError('Trop de demandes au serveur d\'itinéraires, réessaie dans une minute', 429);
      throw new RouteError((data && data.error) || ('Erreur du serveur d\'itinéraires (' + res.status + ')'), data?.error_code || res.status);
    }
    const out = [normalizeTrip(data.trip)];
    for (const alt of data.alternates || []) if (alt.trip) out.push(normalizeTrip(alt.trip));
    for (const r of out) r.profile = costingName;
    return alternates ? out : out[0];
  });
}

const TURN_TYPES = new Set([9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 23, 24, 26, 27, 36, 37]);

// Convertit un trajet Valhalla en structure interne : un seul tracé, manœuvres indexées dessus.
export function normalizeTrip(trip) {
  const shape = [];
  const maneuvers = [];
  const legs = [];
  trip.legs.forEach((leg, li) => {
    const pts = decodePolyline(leg.shape, 6);
    const offset = shape.length === 0 ? 0 : shape.length - 1;
    const start = shape.length === 0 ? 0 : 1;
    for (let i = start; i < pts.length; i++) shape.push(pts[i]);
    for (const m of leg.maneuvers) {
      // Les arrivées intermédiaires sont gardées : elles marquent les pauses.
      maneuvers.push({
        type: m.type,
        instruction: m.instruction || '',
        alert: m.verbal_transition_alert_instruction || '',
        pre: m.verbal_pre_transition_instruction || m.instruction || '',
        post: m.verbal_post_transition_instruction || '',
        streets: m.street_names || m.begin_street_names || [],
        time: m.time || 0,
        lengthKm: m.length || 0,
        begin: m.begin_shape_index + offset,
        end: m.end_shape_index + offset,
        exit: m.roundabout_exit_count || 0,
        leg: li,
        isTurn: TURN_TYPES.has(m.type),
        // Départ d'une étape après une pause : pas d'annonce « partez ».
        legStart: li > 0 && [1, 2, 3].includes(m.type),
      });
    }
    legs.push({
      begin: offset,
      end: offset + pts.length - 1,
      timeS: leg.summary?.time || 0,
      lengthKm: leg.summary?.length || 0,
    });
  });
  return finalizeRoute({
    shape,
    maneuvers,
    legs,
    timeS: trip.summary.time,
    lengthKm: trip.summary.length,
    hasHighway: !!trip.summary.has_highway,
    hasToll: !!trip.summary.has_toll,
    hasFerry: !!trip.summary.has_ferry,
  });
}

// Calcule distances et temps cumulés le long du tracé (le temps est réparti
// proportionnellement à la distance à l'intérieur de chaque manœuvre).
export function finalizeRoute(r) {
  r.cum = cumulative(r.shape);
  const n = r.shape.length;
  const cumTime = new Float64Array(n);
  const segTime = new Float64Array(Math.max(0, n - 1));
  for (const m of r.maneuvers) {
    const b = m.begin, e = Math.min(m.end, n - 1);
    const len = r.cum[e] - r.cum[b];
    for (let i = b; i < e; i++) {
      segTime[i] = len > 0 ? m.time * (r.cum[i + 1] - r.cum[i]) / len : 0;
    }
  }
  for (let i = 1; i < n; i++) cumTime[i] = cumTime[i - 1] + segTime[i - 1];
  // Recalage sur la durée annoncée par le serveur.
  const total = cumTime[n - 1];
  if (total > 0 && r.timeS > 0) {
    const k = r.timeS / total;
    for (let i = 0; i < n; i++) cumTime[i] *= k;
  }
  r.cumTime = cumTime;
  for (const m of r.maneuvers) {
    m.along = r.cum[m.begin];
    m.alongEnd = r.cum[Math.min(m.end, n - 1)];
  }
  r.totalM = r.cum[n - 1];
  return r;
}

export function timeAt(r, along) {
  const { cum, cumTime } = r;
  if (along <= 0) return 0;
  if (along >= cum[cum.length - 1]) return cumTime[cumTime.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
  const segLen = cum[hi] - cum[lo];
  const t = segLen > 0 ? (along - cum[lo]) / segLen : 0;
  return cumTime[lo] + t * (cumTime[hi] - cumTime[lo]);
}

export function alongAtTime(r, tSec) {
  const { cum, cumTime } = r;
  if (tSec <= 0) return 0;
  const n = cumTime.length;
  if (tSec >= cumTime[n - 1]) return cum[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumTime[mid] <= tSec) lo = mid; else hi = mid; }
  const dt = cumTime[hi] - cumTime[lo];
  const f = dt > 0 ? (tSec - cumTime[lo]) / dt : 0;
  return cum[lo] + f * (cum[hi] - cum[lo]);
}

// Voies empruntées par un tracé (Valhalla trace_attributes) : identifiant OSM, longueur,
// revêtement, usage (piste, route…), classe de route, vitesse, et point milieu.
export async function traceEdges(shape, { signal } = {}) {
  const attrs = ['edge.way_id', 'edge.length', 'edge.surface', 'edge.use', 'edge.road_class', 'edge.speed'];
  const post = (body) => valhallaQueue.run(async () => {
    const t = timed(signal, 30000);
    try {
      // text/plain : requête « simple », sans pré-vérification CORS.
      const res = await fetch(ENDPOINTS.valhalla.replace(/route$/, 'trace_attributes'), {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), signal: t.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.edges) throw new Error('trace_attributes ' + res.status);
      return data.edges;
    } catch (e) {
      if (signal?.aborted) throw new AbortedError();
      throw e;
    } finally { t.done(); }
  });
  let edges;
  try {
    // Le tracé vient de Valhalla : correspondance exacte (rapide).
    edges = await post({ encoded_polyline: encodePolyline(shape, 6), costing: 'auto', shape_match: 'edge_walk', filters: { attributes: attrs, action: 'include' } });
  } catch (e) {
    if (e instanceof AbortedError) throw e;
    let pts = simplify(shape, 15);
    if (pts.length > 4000) { const k = Math.ceil(pts.length / 4000); pts = pts.filter((_, i) => i % k === 0 || i === pts.length - 1); }
    edges = await post({ shape: pts.map(([lat, lon]) => ({ lat: +lat.toFixed(6), lon: +lon.toFixed(6) })), costing: 'auto', shape_match: 'map_snap', filters: { attributes: attrs, action: 'include' } });
  }
  // Point milieu de chaque voie, retrouvé par la distance parcourue sur notre tracé.
  const cum = cumulative(shape);
  const total = cum[cum.length - 1];
  const sumKm = edges.reduce((a, e) => a + (e.length || 0), 0) || 1;
  const k = total / (sumKm * 1000);
  let acc = 0;
  return edges.map((e) => {
    const km = e.length || 0;
    const mid = pointAlong(shape, cum, Math.min(total, (acc + km / 2) * 1000 * k));
    const startM = acc * 1000 * k;
    acc += km;
    return { way_id: e.way_id, length: km, surface: e.surface, use: e.use, road_class: e.road_class, speed: e.speed, mid, startM };
  });
}

// Itinéraire qui suit une trace GPX (Valhalla trace_route), avec manœuvres et instructions.
export async function traceRoute(points, settings, { signal } = {}) {
  let pts = simplify(points, 10);
  if (pts.length > 3000) { const k = Math.ceil(pts.length / 3000); pts = pts.filter((_, i) => i % k === 0 || i === pts.length - 1); }
  const body = {
    shape: pts.map(([lat, lon]) => ({ lat: +lat.toFixed(6), lon: +lon.toFixed(6) })),
    costing: 'motorcycle',
    costing_options: { motorcycle: { ...costingOptions(settings), use_trails: 1, exclude_unpaved: false } },
    shape_match: 'map_snap',
    directions_options: { units: 'kilometers', language: 'fr-FR' },
  };
  return valhallaQueue.run(async () => {
    const t = timed(signal, 40000);
    try {
      const res = await fetch(ENDPOINTS.valhalla.replace(/route$/, 'trace_route'), {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), signal: t.signal,
      });
      const data = await res.json();
      if (!res.ok || !data.trip) throw new RouteError(data?.error || 'Trace impossible à suivre', data?.error_code || res.status);
      const r = normalizeTrip(data.trip);
      r.profile = 'motorcycle';
      return r;
    } catch (e) {
      if (signal?.aborted) throw new AbortedError();
      throw e;
    } finally { t.done(); }
  });
}

// Assemble des itinéraires bout à bout (approche, tronçon de trace, retour).
// `labels[i]` remplace l'instruction de départ du morceau i (i > 0), annoncée comme une manœuvre normale.
const ARRIVE = new Set([4, 5, 6]);
export function joinRoutes(parts, labels = []) {
  const shape = [], maneuvers = [], legs = [];
  let timeS = 0, lengthKm = 0;
  parts.forEach((r, pi) => {
    const offset = shape.length ? shape.length - 1 : 0;
    for (let i = shape.length ? 1 : 0; i < r.shape.length; i++) shape.push(r.shape[i]);
    const legBase = legs.length;
    const last = pi === parts.length - 1;
    r.maneuvers.forEach((m, mi) => {
      if (!last && ARRIVE.has(m.type) && mi === r.maneuvers.length - 1) return;
      const { along, alongEnd, ...rest } = m;
      const mm = { ...rest, begin: m.begin + offset, end: m.end + offset, leg: (m.leg || 0) + legBase };
      if (pi > 0 && mi === 0) {
        mm.legStart = false;
        if (labels[pi]) { mm.instruction = labels[pi]; mm.pre = labels[pi]; mm.alert = labels[pi]; }
      }
      maneuvers.push(mm);
    });
    const rl = r.legs && r.legs.length ? r.legs : [{ begin: 0, end: r.shape.length - 1, timeS: r.timeS, lengthKm: r.lengthKm }];
    for (const l of rl) legs.push({ ...l, begin: l.begin + offset, end: l.end + offset });
    timeS += r.timeS; lengthKm += r.lengthKm;
  });
  return finalizeRoute({ shape, maneuvers, legs, timeS, lengthKm, profile: parts[0]?.profile });
}

// Morceau d'un itinéraire entre deux distances (m) depuis le départ.
export function sliceRoute(r, fromM, toM) {
  const i0 = Math.max(0, segmentAt(r.cum, fromM));
  const i1 = Math.min(r.shape.length - 1, Math.max(i0 + 1, segmentAt(r.cum, toM) + 1));
  const shape = r.shape.slice(i0, i1 + 1);
  const maneuvers = [];
  for (const m of r.maneuvers) {
    if (ARRIVE.has(m.type)) continue;
    const b = Math.max(m.begin, i0), e = Math.min(m.end, i1);
    if (e < b || (e === b && m.begin !== m.end)) continue;
    const full = Math.max(1, r.cum[m.end] - r.cum[m.begin]);
    const part = r.cum[e] - r.cum[b];
    const { along, alongEnd, ...rest } = m;
    maneuvers.push({ ...rest, begin: b - i0, end: e - i0, time: m.time * Math.min(1, part / full), lengthKm: part / 1000, leg: 0, legStart: false });
  }
  const n = shape.length - 1;
  maneuvers.push({ type: 4, instruction: '', alert: '', pre: '', post: '', streets: [], time: 0, lengthKm: 0, begin: n, end: n, leg: 0, isTurn: false });
  const timeS = r.cumTime[i1] - r.cumTime[i0];
  const lengthKm = (r.cum[i1] - r.cum[i0]) / 1000;
  return finalizeRoute({ shape, maneuvers, legs: [{ begin: 0, end: n, timeS, lengthKm }], timeS, lengthKm });
}

// Itinéraire « géométrique » le long d'une trace, si trace_route échoue (sans réseau par exemple).
export function geometricRoute(points) {
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const timeS = total / (25 / 3.6);
  return finalizeRoute({
    shape: points,
    maneuvers: [
      { type: 1, instruction: 'Suivez la trace.', alert: 'Suivez la trace.', pre: 'Suivez la trace.', streets: [], time: timeS, lengthKm: total / 1000, begin: 0, end: points.length - 1, isTurn: false },
      { type: 4, instruction: 'Fin de la trace.', alert: '', pre: 'Fin de la trace.', streets: [], time: 0, lengthKm: 0, begin: points.length - 1, end: points.length - 1, isTurn: false },
    ],
    legs: [], timeS, lengthKm: total / 1000,
  });
}

// Part de petites routes d'un tracé.
const SMALL_CLASSES = new Set(['tertiary', 'unclassified', 'residential', 'service_other', 'service', 'living_street', 'track']);
export async function roadClassShare(shape, { signal } = {}) {
  const edges = await traceEdges(shape, { signal });
  let small = 0, total = 0;
  const byClass = {};
  for (const e of edges) {
    total += e.length;
    byClass[e.road_class] = (byClass[e.road_class] || 0) + e.length;
    if (SMALL_CLASSES.has(e.road_class)) small += e.length;
  }
  return { small: total ? small / total : 0, byClass, totalKm: total };
}

// --- Overpass ---------------------------------------------------------------

// Essaie plusieurs serveurs Overpass, chacun avec un délai maximal (ils sont parfois saturés).
export async function overpass(query, { signal, timeoutMs = 25000, maxTries = 3 } = {}) {
  let lastErr;
  for (const ep of ENDPOINTS.overpass.slice(0, maxTries)) {
    if (signal?.aborted) throw new AbortedError();
    const t = timed(signal, timeoutMs);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: t.signal,
      });
      if (!res.ok) { lastErr = new Error('Overpass ' + res.status); continue; }
      const data = await res.json();
      return data.elements || [];
    } catch (e) {
      if (signal?.aborted) throw new AbortedError();
      lastErr = e;
    } finally { t.done(); }
  }
  throw lastErr || new Error('Overpass injoignable');
}

// Tags OpenStreetMap d'une liste de voies (par paquets).
export async function wayTags(ids, { signal } = {}) {
  const out = new Map();
  const uniq = [...new Set(ids.filter((x) => x != null))];
  for (let i = 0; i < uniq.length; i += 400) {
    const chunk = uniq.slice(i, i + 400);
    const els = await overpass(`[out:json][timeout:25];way(id:${chunk.join(',')});out tags;`, { signal, timeoutMs: 25000 });
    for (const el of els) out.set(el.id, el.tags || {});
  }
  return out;
}

// Pistes d'une zone (centre et tags), non interdites aux motos, longues d'au moins 800 m.
export async function tracksInArea(bb, { signal } = {}) {
  const q = `[out:json][timeout:25][bbox:${bb.s.toFixed(4)},${bb.w.toFixed(4)},${bb.n.toFixed(4)},${bb.e.toFixed(4)}];`
    + 'way["highway"="track"]["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private|forestry|agricultural)$"]["motorcycle"!~"^(no|private)$"](if: length() > 800);out tags center;';
  const els = await overpass(q, { signal, timeoutMs: 25000, maxTries: 2 });
  return els.filter((el) => el.center).map((el) => ({ id: el.id, point: [el.center.lat, el.center.lon], tags: el.tags || {} }));
}

export function elementPoint(el) {
  if (el.lat != null) return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  return null;
}

// --- Photon (recherche d'adresse) ------------------------------------------

export async function searchPlaces(q, near, { signal } = {}) {
  const params = new URLSearchParams({ q, limit: '6', lang: 'fr' });
  if (near) { params.set('lat', near[0].toFixed(4)); params.set('lon', near[1].toFixed(4)); }
  const t = timed(signal, 10000);
  let res;
  try { res = await fetch(ENDPOINTS.photon + '?' + params, { signal: t.signal }); } finally { t.done(); }
  if (!res.ok) throw new Error('Recherche d\'adresse indisponible');
  const data = await res.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const sub = [p.city && p.city !== main ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
    return { label: main, sub, point: [f.geometry.coordinates[1], f.geometry.coordinates[0]] };
  }).filter((r) => r.label);
}
