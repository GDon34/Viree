// Service worker : l'appli s'ouvre même sans réseau, et les fonds de carte déjà vus restent en cache.
const VERSION = 'viree-v3';
const APP = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/geo.js', 'js/services.js', 'js/planner.js', 'js/stops.js', 'js/names.js',
  'js/settings.js', 'js/store.js', 'js/format.js', 'js/map.js', 'js/navigator.js', 'js/voice.js', 'js/gpx.js', 'js/sim.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/leaflet-rotate/leaflet-rotate.js',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
  'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png',
];
const TILE_CACHE = 'viree-tiles';
const TILE_MAX = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > TILE_MAX) for (const k of keys.slice(0, keys.length - TILE_MAX)) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Fonds de carte : cache d'abord (utile dans les zones sans réseau).
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILE_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { c.put(e.request, res.clone()); if (Math.random() < 0.02) trimTiles(); }
      return res;
    }));
    return;
  }
  // Fichiers de l'appli : réseau d'abord (pour avoir les mises à jour), cache sinon.
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
  }
});
