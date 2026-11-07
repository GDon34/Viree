// Outils géométriques. Les points sont des tableaux [lat, lon] en degrés.

export const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Cap initial de a vers b, en degrés [0, 360).
export function bearing(a, b) {
  const la1 = a[0] * RAD, la2 = b[0] * RAD, dLon = (b[1] - a[1]) * RAD;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

// Point atteint depuis p en suivant le cap brg (degrés) sur dist mètres.
export function destination(p, brg, dist) {
  const d = dist / EARTH_R, t = brg * RAD;
  const la1 = p[0] * RAD, lo1 = p[1] * RAD;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(t));
  const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1),
    Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 * DEG, ((lo2 * DEG + 540) % 360) - 180];
}

// Différence signée b - a ramenée dans (-180, 180].
export function angleDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Décodage d'une polyline encodée (Valhalla : précision 6).
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const pts = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    pts.push([lat / factor, lon / factor]);
  }
  return pts;
}

export function encodePolyline(pts, precision = 6) {
  const factor = 10 ** precision;
  let out = '', pLat = 0, pLon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, lo] of pts) {
    const iLat = Math.round(la * factor), iLon = Math.round(lo * factor);
    out += enc(iLat - pLat) + enc(iLon - pLon);
    pLat = iLat; pLon = iLon;
  }
  return out;
}

export function cumulative(pts) {
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i]);
  return cum;
}

// Projection de p sur le segment [a, b] (approximation plane locale, valable à petite échelle).
export function projectOnSegment(p, a, b) {
  const kx = Math.cos(p[0] * RAD) * EARTH_R * RAD;
  const ky = EARTH_R * RAD;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { t, dist: Math.hypot(x, y) };
}

// Point le plus proche sur une polyligne, en cherchant dans les segments [from, to).
export function nearestOnLine(pts, cum, p, from = 0, to = pts.length - 1) {
  from = Math.max(0, from);
  to = Math.min(pts.length - 1, to);
  let best = { dist: Infinity, idx: 0, t: 0, along: 0 };
  for (let i = from; i < to; i++) {
    const r = projectOnSegment(p, pts[i], pts[i + 1]);
    if (r.dist < best.dist) {
      best = { dist: r.dist, idx: i, t: r.t, along: cum[i] + r.t * (cum[i + 1] - cum[i]) };
    }
  }
  return best;
}

// Indice du segment contenant la distance curviligne d (recherche dichotomique).
export function segmentAt(cum, d) {
  let lo = 0, hi = cum.length - 1;
  if (d <= 0) return 0;
  if (d >= cum[hi]) return Math.max(0, hi - 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  return lo;
}

export function pointAlong(pts, cum, d) {
  const i = segmentAt(cum, d);
  const segLen = cum[i + 1] - cum[i];
  const t = segLen > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / segLen)) : 0;
  const a = pts[i], b = pts[i + 1] || pts[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Rééchantillonne la polyligne tous les `step` mètres.
export function resample(pts, cum, step) {
  const total = cum[cum.length - 1];
  const out = [];
  for (let d = 0; d <= total; d += step) out.push(pointAlong(pts, cum, d));
  if (total % step > step * 0.3) out.push(pts[pts.length - 1]);
  return out;
}

// Simplification Douglas-Peucker (tolérance en mètres).
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projectOnSegment(pts[i], pts[s], pts[e]).dist;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function bbox(pts, marginM = 0) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of pts) {
    if (la < s) s = la; if (la > n) n = la;
    if (lo < w) w = lo; if (lo > e) e = lo;
  }
  if (marginM) {
    const dLat = marginM / 111320;
    const dLon = marginM / (111320 * Math.cos(((s + n) / 2) * RAD));
    s -= dLat; n += dLat; w -= dLon; e += dLon;
  }
  return { s, w, n, e };
}

// Petit générateur pseudo-aléatoire déterministe (mulberry32).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Index spatial grossier : clé de cellule pour une taille donnée (mètres).
export function cellKey(p, sizeM) {
  const y = Math.floor((p[0] * 111320) / sizeM);
  const x = Math.floor((p[1] * 111320 * Math.cos(p[0] * RAD)) / sizeM);
  return x + ':' + y;
}
