// Pauses et plein d'essence le long d'un parcours.
import { simplify, cellKey, haversine, nearestOnLine, pointAlong } from './geo.js';
import { overpass, elementPoint, timeAt, alongAtTime } from './services.js';

const KIND_LABEL = {
  cafe: 'Café',
  restaurant: 'Restaurant',
  viewpoint: 'Belvédère',
  picnic: 'Aire de pique-nique',
  fuel: 'Station-service',
};

function lineCoords(r) {
  let pts = simplify(r.shape, 120);
  if (pts.length > 280) {
    const stepIdx = Math.ceil(pts.length / 280);
    pts = pts.filter((_, i) => i % stepIdx === 0 || i === pts.length - 1);
  }
  return pts.map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(',');
}

export function stopQuery(routes) {
  const parts = [];
  for (const r of routes) {
    const c = lineCoords(r);
    parts.push(
      `nw["amenity"~"^(cafe|bar|restaurant|fast_food|ice_cream|fuel)$"](around:500,${c});`,
      `node["tourism"~"^(viewpoint|picnic_site)$"](around:400,${c});`,
    );
  }
  // « out center; » garde les coordonnées des nœuds et donne le centre des surfaces.
  return `[out:json][timeout:30];(\n${parts.join('\n')}\n);out center;`;
}

export function classifyStop(el) {
  const t = el.tags || {};
  const point = elementPoint(el);
  if (!point) return null;
  let kind = null;
  if (t.amenity === 'fuel') kind = 'fuel';
  else if (['cafe', 'bar', 'ice_cream'].includes(t.amenity)) kind = 'cafe';
  else if (['restaurant', 'fast_food'].includes(t.amenity)) kind = 'restaurant';
  else if (t.tourism === 'viewpoint') kind = 'viewpoint';
  else if (t.tourism === 'picnic_site' || t.leisure === 'picnic_table') kind = 'picnic';
  if (!kind) return null;
  return {
    id: el.type + el.id,
    kind,
    name: t.name || t.brand || '',
    point,
    tags: t,
  };
}

export async function fetchStopPois(routes, settings, { signal } = {}) {
  if (!routes.length) return [];
  const els = await overpass(stopQuery(routes), { signal, timeoutMs: 30000 });
  const seen = new Set();
  const out = [];
  for (const el of els) {
    const s = classifyStop(el);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// Projette les lieux sur le parcours (index spatial pour aller vite).
function projectPois(r, pois) {
  const grid = new Map();
  for (let i = 0; i < r.shape.length - 1; i++) {
    const k = cellKey(r.shape[i], 700);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  const out = [];
  for (const poi of pois) {
    const [cx, cy] = cellKey(poi.point, 700).split(':').map(Number);
    const idxs = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = grid.get((cx + dx) + ':' + (cy + dy));
      if (l) for (const i of l) { idxs.add(i); if (i > 0) idxs.add(i - 1); }
    }
    if (!idxs.size) continue;
    let best = null;
    for (const i of idxs) {
      const n = nearestOnLine(r.shape, r.cum, poi.point, i, i + 1);
      if (!best || n.dist < best.dist) best = n;
    }
    const maxD = poi.kind === 'fuel' ? 500 : poi.kind === 'picnic' ? 300 : 450;
    if (best && best.dist <= maxD) {
      out.push({ ...poi, along: best.along, dist: best.dist, timeS: timeAt(r, best.along) });
    }
  }
  return out;
}

function stopLabel(s) {
  if (s.kind === 'fuel') return s.hasCafe ? 'Plein + café' : 'Plein + pause';
  if (s.kind === 'restaurant') return 'Pause déjeuner';
  if (s.kind === 'viewpoint') return s.hasCafe ? 'Pause café avec vue' : 'Pause au belvédère';
  if (s.kind === 'picnic') return 'Pause pique-nique';
  return 'Pause café';
}

function makeStop(r, p, settings, kind) {
  return {
    kind,
    poiKind: p.kind,
    label: stopLabel(p),
    name: p.name || KIND_LABEL[p.kind],
    point: p.point,
    routePoint: pointAlong(r.shape, r.cum, p.along),
    along: p.along,
    distFromRoute: Math.round(p.dist),
    timeS: p.timeS,
    durationS: settings.pauseDurationMin * 60,
    hasCafe: !!p.hasCafe,
    id: p.id,
  };
}

/*
  Place les pauses (une par intervalle) et le plein (calé sur une pause, avant d'entamer
  la marge de sécurité). Renvoie { stops, fuelWarning }.
*/
export function placeStops(r, pois, settings, fuelKm, departure = new Date()) {
  const proj = projectPois(r, pois);
  const cafes = proj.filter((p) => p.kind === 'cafe' || p.kind === 'restaurant');
  for (const p of proj) {
    if (p.kind === 'fuel' || p.kind === 'viewpoint') {
      p.hasCafe = p.tags?.shop === 'convenience' && p.kind === 'fuel'
        ? false
        : cafes.some((c) => haversine(c.point, p.point) < 250);
    }
  }
  const types = settings.pauseTypes || {};
  const pauseCands = proj.filter((p) => p.kind !== 'fuel' && types[p.kind] !== false);
  const stations = proj.filter((p) => p.kind === 'fuel');

  const totalS = r.timeS;
  const totalKm = r.totalM / 1000;
  const interval = Math.max(20, settings.pauseEveryMin) * 60;
  const safety = settings.safetyKm;
  const full = settings.fullTankKm;

  const stops = [];
  let fuelWarning = null;
  let fuelBlocked = false;
  let lastT = 0, lastAlong = 0;
  let tankKm = fuelKm, tankFrom = 0; // autonomie disponible depuis le km tankFrom
  const usedIds = new Set();
  let hadLunch = false;
  let pauseFirst = false;
  let guard = 0;

  const clockHour = (tS) => {
    const d = new Date(departure.getTime() + (tS + stops.reduce((a, s) => a + s.durationS, 0)) * 1000);
    return d.getHours() + d.getMinutes() / 60;
  };

  if (fuelKm - safety <= 3) {
    fuelWarning = { kind: 'start', message: 'Autonomie faible au départ : plein prévu dès que possible' };
  }

  while (guard++ < 30) {
    const nextT = lastT + interval;
    const deadlineKm = (tankFrom + tankKm - safety);
    const needFuel = !fuelBlocked && deadlineKm < totalKm;
    // Le plein se fait à cette pause-ci si on ne tiendrait pas jusqu'à la suivante.
    const kmAtFollowing = alongAtTime(r, Math.min(totalS, nextT + interval + 600)) / 1000;

    if (needFuel && kmAtFollowing >= deadlineKm - 10) {
      // Au départ avec un réservoir presque vide, on accepte la première station des 15 km.
      const limitKm = tankFrom === 0 ? Math.max(deadlineKm, Math.min(15, totalKm)) : deadlineKm;
      const minAlong = tankFrom === 0 && deadlineKm < 15 ? 0 : lastAlong + 3000;
      const options = stations.filter((s) => !usedIds.has(s.id) && s.along / 1000 <= limitKm && s.along > minAlong);
      if (!options.length) {
        fuelBlocked = true;
        fuelWarning = { kind: 'none', atKm: Math.max(0, Math.round(deadlineKm)),
          message: `Pas de station repérée avant le km ${Math.max(0, Math.round(deadlineKm))} : prévois le plein avant` };
        continue;
      }
      let best = null, bestScore = -Infinity;
      for (const s of options) {
        const sc = -Math.abs(s.timeS - nextT) / 900 + (s.along / 1000 / deadlineKm) * 0.8 + (s.hasCafe ? 0.4 : 0) - s.dist / 1000;
        if (sc > bestScore) { bestScore = sc; best = s; }
      }
      if (best.timeS - nextT > 20 * 60 && !pauseFirst) {
        // La seule station est bien plus loin : on fait d'abord une vraie pause.
        pauseFirst = true;
      } else {
        usedIds.add(best.id);
        const stop = makeStop(r, best, settings, 'fuel');
        if (stops.length && best.timeS - lastT < 35 * 60) {
          stop.label = 'Plein rapide';
          stop.durationS = 10 * 60;
        }
        stops.push(stop);
        lastT = best.timeS; lastAlong = best.along;
        tankFrom = best.along / 1000; tankKm = full;
        pauseFirst = false;
        continue;
      }
    }

    if (nextT > totalS - 15 * 60) break;

    let best = null, bestScore = -Infinity;
    for (const win of [15 * 60, 25 * 60]) {
      for (const p of pauseCands) {
        if (usedIds.has(p.id)) continue;
        const dt = Math.abs(p.timeS - nextT);
        if (dt > win || p.along <= lastAlong + 2000) continue;
        let base = p.kind === 'cafe' ? 1 : p.kind === 'viewpoint' ? 0.9 : p.kind === 'picnic' ? 0.6 : 0.8;
        if (p.kind === 'restaurant') {
          const h = clockHour(p.timeS);
          if (h >= 11.75 && h <= 14 && !hadLunch) base = 1.4;
          else if (hadLunch) base = 0.5;
        }
        if (p.kind === 'viewpoint' && p.hasCafe) base += 0.4;
        if (p.name) base += 0.1;
        const sc = base - (dt / 1200) * 0.5 - (p.dist / 450) * 0.3;
        if (sc > bestScore) { bestScore = sc; best = p; }
      }
      if (best) break;
    }
    if (best) {
      usedIds.add(best.id);
      if (best.kind === 'restaurant') hadLunch = true;
      stops.push(makeStop(r, best, settings, 'pause'));
      lastT = best.timeS; lastAlong = best.along;
    } else {
      // Pas de lieu trouvé : on avance quand même le compteur pour la pause suivante.
      lastT = nextT;
      lastAlong = alongAtTime(r, nextT);
    }
  }
  stops.sort((a, b) => a.along - b.along);
  return { stops, fuelWarning };
}
