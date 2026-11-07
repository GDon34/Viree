// Mémoire de l'appli, sur le téléphone uniquement :
// - IndexedDB : sorties effectuées (avec trace) et parcours aimés (pour les refaire)
// - localStorage : votes et goûts appris
import { encodePolyline, decodePolyline, resample, simplify, cellKey, cumulative } from './geo.js';
import { finalizeRoute } from './services.js';

const DB_NAME = 'viree';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('IndexedDB indisponible')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('rides')) d.createObjectStore('rides', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('liked')) d.createObjectStore('liked', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// --- Empreinte d'un tracé (cellules de 500 m), pour comparer des parcours ---------

export function cellsOfShape(shape) {
  const cum = cumulative(shape);
  const set = new Set();
  for (const p of resample(shape, cum, 250)) set.add(cellKey(p, 500));
  return set;
}

// Part du parcours `a` déjà couverte par l'empreinte `b`.
export function coverage(aCells, bCells) {
  if (!aCells.size) return 0;
  let n = 0;
  for (const k of aCells) if (bCells.has(k)) n++;
  return n / aCells.size;
}

// --- Sérialisation d'un parcours (pour le refaire plus tard) ---------------------

export function packOption(o) {
  const r = o.route;
  return {
    name: o.name, mode: o.mode, start: o.start, end: o.end, waypoints: o.waypoints,
    stops: (o.stops || []).map((s) => ({ ...s })),
    metrics: o.metrics ? {
      degPerKm: o.metrics.degPerKm, curvRating: o.metrics.curvRating, panoramaCount: o.metrics.panoramaCount,
      panoramaScore: o.metrics.panoramaScore, manDensity: o.metrics.manDensity, overlap: o.metrics.overlap,
      highest: o.metrics.highest, sights: o.metrics.sights, lakes: o.metrics.lakes,
    } : null,
    route: {
      shape: encodePolyline(r.shape, 6),
      maneuvers: r.maneuvers.map(({ along, alongEnd, ...m }) => m),
      legs: r.legs, timeS: r.timeS, lengthKm: r.lengthKm,
    },
    withStops: !!o.withStops,
  };
}

export function unpackOption(p) {
  const route = finalizeRoute({ ...p.route, shape: decodePolyline(p.route.shape, 6) });
  return { ...p, route, metrics: p.metrics || { sights: [], lakes: [], curvRating: 0, panoramaCount: 0 } };
}

// --- Sorties ------------------------------------------------------------------------

export async function saveRide(ride) {
  return tx('rides', 'readwrite', (s) => s.put(ride));
}

export async function listRides() {
  try {
    const all = await tx('rides', 'readonly', (s) => reqP(s.getAll()));
    return (all || []).sort((a, b) => b.date - a.date);
  } catch { return []; }
}

export async function deleteRide(id) {
  return tx('rides', 'readwrite', (s) => s.delete(id));
}

export async function rateRide(id, rating) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('rides', 'readwrite');
    const s = t.objectStore('rides');
    const g = s.get(id);
    g.onsuccess = () => { const r = g.result; if (r) { r.rating = rating; s.put(r); } };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Construit l'enregistrement d'une sortie terminée.
export function rideRecord(sum, option) {
  const track = sum.track.map((t) => [t[0], t[1]]);
  const light = track.length > 2 ? simplify(track, 6) : track;
  return {
    id: 'r' + sum.startedAt,
    date: sum.startedAt,
    endedAt: sum.endedAt,
    name: option.name,
    mode: option.mode,
    km: Math.round(sum.odometerM / 100) / 10,
    movingS: Math.round(sum.movingS),
    pauses: sum.pausesDone,
    arrived: !!sum.arrived,
    rating: null,
    track: light.length > 1 ? encodePolyline(light, 5) : '',
    cells: light.length > 1 ? [...cellsOfShape(light)] : [],
    option: packOption(option),
  };
}

export function rideTrack(ride) {
  return ride.track ? decodePolyline(ride.track, 5) : [];
}

// --- Parcours aimés -----------------------------------------------------------------

export async function saveLiked(id, option) {
  return tx('liked', 'readwrite', (s) => s.put({ id, date: Date.now(), option: packOption(option) }));
}
export async function deleteLiked(id) {
  return tx('liked', 'readwrite', (s) => s.delete(id));
}
export async function listLiked() {
  try {
    const all = await tx('liked', 'readonly', (s) => reqP(s.getAll()));
    return (all || []).sort((a, b) => b.date - a.date);
  } catch { return []; }
}

// --- Votes et goûts (localStorage) --------------------------------------------------

const VOTES_KEY = 'viree.votes.v1';
const PREFS_KEY = 'viree.prefs.v1';
export const TASTES = [
  { key: 'curv', label: 'Virages' },
  { key: 'pano', label: 'Panoramas' },
  { key: 'lake', label: 'Bords de lacs' },
  { key: 'calm', label: 'Routes tranquilles' },
];

function readJson(key, def) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch { return def; }
}
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* stockage plein ou indisponible */ }
}

export function loadPrefs() {
  return { curv: 0, pano: 0, lake: 0, calm: 0, n: 0, ...readJson(PREFS_KEY, {}) };
}
export function resetPrefs() { writeJson(PREFS_KEY, {}); }

export function loadVotes() { return readJson(VOTES_KEY, []); }
export function clearVotes() { writeJson(VOTES_KEY, []); }

// Signal : +1 (pouce haut), -1 (pouce bas), ou (note-3)/2 × 1,5 pour une note sur 5.
// `ref` = caractéristiques moyennes des parcours proposés au même moment (préférence relative).
export function learn(features, signal, ref) {
  const p = loadPrefs();
  const rate = 0.25;
  for (const { key } of TASTES) {
    const delta = (features[key] ?? 0.5) - (ref?.[key] ?? 0.5);
    p[key] = Math.max(-1, Math.min(1, (p[key] || 0) + rate * signal * delta * 2));
  }
  p.n = (p.n || 0) + 1;
  writeJson(PREFS_KEY, p);
  return p;
}

export function recordVote(v) {
  const votes = loadVotes();
  votes.unshift(v);
  writeJson(VOTES_KEY, votes.slice(0, 300));
}

// Trajets à ne plus proposer : sorties effectuées + parcours refusés.
export async function exclusionSets() {
  const sets = [];
  // Les sorties simulées ne comptent pas comme des trajets déjà faits.
  for (const r of await listRides()) if (!r.simulated && r.cells?.length) sets.push({ why: 'ride', cells: new Set(r.cells) });
  for (const v of loadVotes()) if (v.vote === 'down' && v.cells?.length) sets.push({ why: 'down', cells: new Set(v.cells) });
  return sets;
}
