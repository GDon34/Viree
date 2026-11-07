// Accès aux services publics gratuits basés sur OpenStreetMap :
// - Valhalla (FOSSGIS) pour les itinéraires, limité à 1 requête par seconde
// - Overpass pour les points d'intérêt
// - Photon (komoot) pour la recherche d'adresses
import { decodePolyline, cumulative } from './geo.js';

export const ENDPOINTS = {
  valhalla: 'https://valhalla1.openstreetmap.de/route',
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  photon: 'https://photon.komoot.io/api/',
};

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

// locations : [{lat, lon, type: 'break'|'through'|'via', heading?}]
export async function route(locations, settings, { signal, costing = {}, alternates = 0 } = {}) {
  const body = {
    locations: locations.map((l) => {
      const o = { lat: +l.lat.toFixed(6), lon: +l.lon.toFixed(6), type: l.type || 'break' };
      if (l.heading != null) { o.heading = Math.round(l.heading); o.heading_tolerance = 60; }
      if (l.radius) o.radius = l.radius;
      if (l.filter) o.search_filter = l.filter;
      return o;
    }),
    costing: 'motorcycle',
    costing_options: { motorcycle: costingOptions(settings, costing) },
    directions_options: { units: 'kilometers', language: 'fr-FR' },
    id: 'viree-gps',
  };
  if (alternates) body.alternates = alternates;
  const url = ENDPOINTS.valhalla + '?json=' + encodeURIComponent(JSON.stringify(body));
  return valhallaQueue.run(async () => {
    if (signal?.aborted) throw new AbortedError();
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new AbortedError();
      throw new RouteError('Serveur d\'itinéraires injoignable (réseau ?)', 'network');
    }
    let data = null;
    try { data = await res.json(); } catch { /* réponse non JSON */ }
    if (!res.ok || !data || !data.trip) {
      if (res.status === 429) throw new RouteError('Trop de demandes au serveur d\'itinéraires, réessaie dans une minute', 429);
      throw new RouteError((data && data.error) || ('Erreur du serveur d\'itinéraires (' + res.status + ')'), data?.error_code || res.status);
    }
    const out = [normalizeTrip(data.trip)];
    for (const alt of data.alternates || []) if (alt.trip) out.push(normalizeTrip(alt.trip));
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

// --- Overpass ---------------------------------------------------------------

export async function overpass(query, { signal } = {}) {
  let lastErr;
  for (const ep of ENDPOINTS.overpass) {
    if (signal?.aborted) throw new AbortedError();
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal,
      });
      if (!res.ok) { lastErr = new Error('Overpass ' + res.status); continue; }
      const data = await res.json();
      return data.elements || [];
    } catch (e) {
      if (e.name === 'AbortError') throw new AbortedError();
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass injoignable');
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
  const res = await fetch(ENDPOINTS.photon + '?' + params, { signal });
  if (!res.ok) throw new Error('Recherche d\'adresse indisponible');
  const data = await res.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || '';
    const sub = [p.city && p.city !== main ? p.city : null, p.state, p.country].filter(Boolean).join(', ');
    return { label: main, sub, point: [f.geometry.coordinates[1], f.geometry.coordinates[0]] };
  }).filter((r) => r.label);
}
