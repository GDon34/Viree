// Cartes Leaflet (fonds OpenStreetMap).
/* global L */
import { destination } from './geo.js';

// Fonds OpenStreetMap standard (sans clé). Le thème nuit est obtenu par un filtre CSS.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>';
// Fond topographique (pistes, courbes de niveau) pour le tout-terrain.
const TOPO_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const TOPO_ATTRIB = 'Carte © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), données © <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>, SRTM';

function tileLayer(kind) {
  return kind === 'topo'
    ? L.tileLayer(TOPO_URL, { maxZoom: 19, maxNativeZoom: 17, subdomains: 'abc', attribution: TOPO_ATTRIB, crossOrigin: true })
    : L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIB, crossOrigin: true });
}

export function setTiles(map, kind) {
  if (!map || map._tilesKind === kind) return;
  if (map._tiles) map._tiles.remove();
  map._tiles = tileLayer(kind).addTo(map);
  map._tiles.bringToBack();
  map._tilesKind = kind;
  map.getContainer().classList.toggle('map-topo', kind === 'topo');
}

export function createMap(el, { rotate = false, theme = 'day', interactive = true, tiles = 'osm' } = {}) {
  const opts = {
    zoomControl: false,
    attributionControl: true,
    dragging: interactive,
    touchZoom: interactive,
    scrollWheelZoom: interactive,
    doubleClickZoom: interactive,
    boxZoom: false,
    keyboard: interactive,
    rotateControl: false, // l'extension de rotation l'ajoute sinon sur toutes les cartes
  };
  if (!rotate) { opts.zoomSnap = 0.25; opts.zoomDelta = 0.5; }
  if (rotate) Object.assign(opts, { rotate: true, touchRotate: false, shiftKeyRotate: false, pitchDrag: false, bearing: 0 });
  const map = L.map(el, opts);
  map.attributionControl.setPrefix(false);
  setTiles(map, tiles);
  setTheme(map, theme);
  return map;
}

export function setTheme(map, theme) {
  if (!map) return;
  map.getContainer().classList.toggle('map-night', theme === 'night');
}

export function routeLayer(r, { color = '#C2410C', weight = 5, casing = '#FFFFFF', opacity = 1 } = {}) {
  const latlngs = r.shape.map((p) => [p[0], p[1]]);
  const g = L.layerGroup();
  if (casing) L.polyline(latlngs, { color: casing, weight: weight + 4, opacity: 0.9 * opacity, lineJoin: 'round', interactive: false }).addTo(g);
  L.polyline(latlngs, { color, weight, opacity, lineJoin: 'round', interactive: false }).addTo(g);
  return g;
}

const ICON_PATHS = {
  start: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  cafe: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/>',
  restaurant: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10"/><path d="M17 3c-2 1-3 3-3 6v3h3v9"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  viewpoint: '<path d="M3 19l6-9 4 6 3-4 5 7z"/>',
  picnic: '<path d="M12 3l6 9h-4l4 6H6l4-6H6z"/><path d="M12 18v3"/>',
  end: '<path d="M5 12l5 5 9-10"/>',
};

export function markerIcon(kind, cls) {
  const stroke = cls === 'sight' ? '#0B6E6E' : '#FFFFFF';
  const size = cls === 'sight' ? 22 : 26;
  return L.divIcon({
    className: '',
    html: `<div class="mk ${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[kind] || ICON_PATHS.viewpoint}</svg></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export function stopMarker(stop) {
  const kind = stop.kind === 'fuel' ? 'fuel' : stop.poiKind;
  return L.marker(stop.point, { icon: markerIcon(kind, stop.kind === 'fuel' ? 'fuel' : 'pause'), keyboard: false, title: stop.label + ' — ' + stop.name });
}

export function meIcon(color = '#FB8A3C') {
  return L.divIcon({
    className: '',
    html: `<div class="me-arrow"><svg width="40" height="40" viewBox="-20 -20 40 40" aria-hidden="true"><circle r="19" fill="${color}" opacity="0.18"/><path d="M0 -14 L11 11 L0 5 L-11 11z" fill="#FFFFFF" stroke="#111417" stroke-width="2" stroke-linejoin="round"/></svg></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

// Centre de carte décalé vers l'avant, pour voir la route devant soi.
export function aheadCenter(map, pos, heading, frac = 0.22) {
  const z = map.getZoom();
  const mpp = 156543.03392 * Math.cos(pos[0] * Math.PI / 180) / Math.pow(2, z);
  const h = map.getSize().y;
  return destination(pos, heading, mpp * h * frac);
}

// Miniature SVG d'un tracé (liste des parcours).
export function thumbSvg(shape, start, size = 76) {
  let s = 90, n = -90, w = 180, e = -180;
  for (const [la, lo] of shape) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const spanX = (e - w) * k, spanY = n - s;
  const span = Math.max(spanX, spanY) || 1e-6;
  const pad = 12, inner = size - 2 * pad;
  const ox = pad + (inner - (spanX / span) * inner) / 2;
  const oy = pad + (inner - (spanY / span) * inner) / 2;
  const proj = ([la, lo]) => [ox + ((lo - w) * k / span) * inner, oy + ((n - la) / span) * inner];
  const step = Math.max(1, Math.floor(shape.length / 150));
  const d = shape.filter((_, i) => i % step === 0 || i === shape.length - 1).map((p, i) => {
    const [x, y] = proj(p);
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join('');
  const [sx, sy] = proj(start);
  return `<svg class="thumb" viewBox="0 0 ${size} ${size}" aria-hidden="true"><rect width="${size}" height="${size}" rx="14" fill="#E5EBE0"/><path d="${d}" fill="none" stroke="#C2410C" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="#15181B"/></svg>`;
}
