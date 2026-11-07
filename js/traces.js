// Traces GPX importées (TET ou autres) : lecture, stockage, boucles qui les empruntent.
import { cumulative, resample, haversine, bearing, destination, encodePolyline, decodePolyline, pointAlong } from './geo.js';

// --- Lecture d'un fichier GPX -----------------------------------------------------

export function parseGpx(text, fallbackName = 'Trace') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Fichier GPX illisible');
  const out = [];
  const readPts = (nodes) => Array.from(nodes).map((n) => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const nameOf = (el, i) => el.getElementsByTagName('name')[0]?.textContent?.trim() || `${fallbackName}${i ? ' ' + (i + 1) : ''}`;
  Array.from(doc.getElementsByTagName('trk')).forEach((trk, i) => {
    const pts = [];
    for (const seg of Array.from(trk.getElementsByTagName('trkseg'))) pts.push(...readPts(seg.getElementsByTagName('trkpt')));
    if (pts.length > 1) out.push({ name: nameOf(trk, i), points: pts });
  });
  Array.from(doc.getElementsByTagName('rte')).forEach((rte, i) => {
    const pts = readPts(rte.getElementsByTagName('rtept'));
    if (pts.length > 1) out.push({ name: nameOf(rte, i), points: pts });
  });
  if (!out.length) throw new Error('Aucune trace trouvée dans ce fichier');
  return out;
}

export function packTrace(t) {
  const cum = cumulative(t.points);
  return {
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: t.name,
    date: Date.now(),
    km: Math.round(cum[cum.length - 1] / 100) / 10,
    poly: encodePolyline(t.points, 5),
    n: t.points.length,
  };
}

export function unpackTrace(rec) {
  const points = decodePolyline(rec.poly, 5);
  return { ...rec, points, cum: cumulative(points) };
}

// --- Boucles qui empruntent une trace ---------------------------------------------

// Sections de traces proches du départ, échantillonnées tous les 500 m.
export function tetSectionsNear(traces, start, radius) {
  const sections = [];
  for (const t of traces) {
    const pts = resample(t.points, t.cum, 500);
    let run = null;
    pts.forEach((p, i) => {
      const inside = haversine(start, p) <= radius;
      if (inside) {
        if (!run) run = { trace: t, pts: [], from: i };
        run.pts.push(p);
      } else if (run) { if (run.pts.length >= 6) sections.push(run); run = null; }
    });
    if (run && run.pts.length >= 6) sections.push(run);
  }
  return sections;
}

/*
  Candidat de boucle passant par un tronçon de trace.
  start → début du tronçon (itinéraire normal) → tronçon suivi exactement (calage de la trace)
  → fin du tronçon → retour par un autre côté (itinéraire normal).
*/
export function traceSlice(trace, d0, d1) {
  const { points, cum } = trace;
  const out = [pointAlong(points, cum, d0)];
  for (let i = 0; i < points.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(points[i]);
  out.push(pointAlong(points, cum, d1));
  return out;
}

// Point de passage décalé sur le côté, pour que l'approche (ou le retour) ne reprenne pas la trace.
export function tetBackPoint(start, far, side, factor = 0.3) {
  const mid = [(far[0] + start[0]) / 2, (far[1] + start[1]) / 2];
  const away = (bearing(start, far) + (side > 0 ? 90 : -90) + 360) % 360;
  return destination(mid, away, Math.max(1500, haversine(far, start) * factor));
}

/*
  On entre sur la trace au point le plus proche du départ, on la suit vers l'extérieur sur la longueur voulue,
  puis on revient par la route en passant par un point décalé. Variante : aller par la route, retour par la trace.
*/
// i parcourt toutes les combinaisons (tronçon, sens, aller ou retour par la trace, longueur) une seule fois ;
// renvoie null quand tout a été essayé, undefined pour une combinaison impossible (on passe à la suivante).
export function tetLoopCandidate(i, start, loopKm, share, sections, rand) {
  if (!sections.length) return null;
  const S = sections.length;
  const round = Math.floor(i / (S * 4));
  if (round >= 2) return null;
  const sec = sections[i % S];
  const variant = Math.floor(i / S) % 4;
  const n = sec.pts.length; // points tous les 500 m
  let entry = 0, bd = Infinity;
  sec.pts.forEach((p, k) => { const d = haversine(start, p); if (d < bd) { bd = d; entry = k; } });
  const wantKm = Math.max(5, Math.min(loopKm * 0.55, loopKm * share * 0.9)) * (round === 0 ? 1 : 0.65);
  const len = Math.max(6, Math.round(wantKm / 0.5));
  const dir = variant % 2 === 0 ? 1 : -1;
  if (dir > 0 ? n - 1 - entry < 6 : entry < 6) return undefined;
  const to = Math.max(0, Math.min(n - 1, entry + dir * len));
  const lo = Math.min(entry, to), hi = Math.max(entry, to);
  let tetPts = traceSlice(sec.trace, (sec.from + lo) * 500, Math.min(sec.trace.cum[sec.trace.cum.length - 1], (sec.from + hi) * 500));
  if (dir < 0) tetPts = tetPts.slice().reverse(); // on part du point d'entrée
  const backFirst = variant >= 2;
  if (backFirst) tetPts = tetPts.slice().reverse(); // aller par la route, retour par la trace
  const a = tetPts[0], b = tetPts[tetPts.length - 1];
  const side = rand() < 0.5 ? 1 : -1;
  const back = tetBackPoint(start, backFirst ? a : b, side);
  return {
    waypoints: backFirst ? [back, a, b] : [a, b, back], tetPts, side, backFirst, snap: true, key: 'TET' + i,
    label: `boucle par la trace « ${sec.trace.name} »`, tet: true, traceName: sec.trace.name,
  };
}

// Option de navigation « suivi de trace » à partir d'une portion de trace.
export function tracePortion(trace, near, maxKm = 150, reverse = false) {
  const pts = trace.points;
  let best = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 4000))) {
    const d = haversine(near, pts[i]);
    if (d < bd) { bd = d; best = i; }
  }
  const out = [];
  let dist = 0;
  const step = reverse ? -1 : 1;
  for (let i = best; i >= 0 && i < pts.length; i += step) {
    if (out.length) dist += haversine(out[out.length - 1], pts[i]);
    out.push(pts[i]);
    if (dist > maxKm * 1000) break;
  }
  return { points: out, startDist: bd };
}

export { pointAlong };
