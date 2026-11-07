// Virée — application (écrans, saisie, recherche, navigation).
/* global L */
import { loadSettings, saveSettings } from './settings.js';
import { planRoutes, routeWithStops, analyzeRoute, abTargetMinutes } from './planner.js';
import { route as fetchRoute, searchPlaces, AbortedError, setRateGap, timeAt } from './services.js';
import { createMap, setTheme, routeLayer, markerIcon, stopMarker, meIcon, aheadCenter, thumbSvg } from './map.js';
import { NavEngine } from './navigator.js';
import { Simulator } from './sim.js';
import { initVoice, speak, setVoiceEnabled, unlockVoice } from './voice.js';
import { routeGpx, trackGpx, downloadText, slug } from './gpx.js';
import { fmtDuration, fmtClockDelta, fmtClock, fmtKm, fmtDist, escapeHtml, isNight } from './format.js';
import { haversine, bearing } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock');

const S = {
  settings: loadSettings(),
  start: { gps: true, label: 'Ma position actuelle', point: null },
  end: null,
  gps: null,
  gpsError: null,
  fast: null, // { key, timeS, lengthKm }
  plan: null,
  result: null,
  option: null,
  maps: {},
  nav: null,
  history: ['screen-home'],
};

// --- Écrans ------------------------------------------------------------------

function show(id, { push = true } = {}) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (push && S.history[S.history.length - 1] !== id) S.history.push(id);
  const m = { 'screen-search': 'search', 'screen-detail': 'detail', 'screen-nav': 'nav', 'screen-end': 'end' }[id];
  if (m && S.maps[m]) setTimeout(() => S.maps[m].invalidateSize(), 50);
  window.scrollTo(0, 0);
}

function back() {
  S.history.pop();
  show(S.history[S.history.length - 1] || 'screen-home', { push: false });
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// --- GPS ---------------------------------------------------------------------

let gpsWatch = null;
const gpsListeners = new Set();

function startGps(force = false) {
  if (MOCK && !force) {
    const w = window.__mockWorld;
    S.gps = { pos: w.places[2].p, accuracy: 8, t: Date.now() };
    updateGpsChip();
    return;
  }
  if (!('geolocation' in navigator)) { S.gpsError = 'GPS indisponible'; updateGpsChip(); return; }
  if (gpsWatch != null) return;
  gpsWatch = navigator.geolocation.watchPosition((p) => {
    S.gps = { pos: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp };
    S.gpsError = null;
    updateGpsChip();
    if (!S.fast && S.settings.mode === 'ab' && S.end && !S.start.point) refreshFast();
    for (const f of gpsListeners) f(p);
  }, (err) => {
    S.gpsError = err.code === 1 ? 'Accès à la position refusé' : 'Position introuvable';
    updateGpsChip();
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}

function updateGpsChip() {
  const chip = $('#gps-chip');
  if (!S.start.gps) { chip.hidden = true; return; }
  chip.hidden = false;
  const ok = S.gps && S.gps.accuracy < 150;
  chip.classList.toggle('bad', !ok);
  chip.lastChild.textContent = S.gpsError ? 'GPS ?' : ok ? 'GPS' : 'GPS…';
  chip.title = S.gpsError || (S.gps ? `Précision ${Math.round(S.gps.accuracy)} m` : 'Recherche du signal');
}

function startPoint() {
  if (S.start.gps) return S.gps ? S.gps.pos : null;
  return S.start.point;
}

// --- Saisie (écran 1) ----------------------------------------------------------

function setMode(mode) {
  S.settings.mode = mode;
  saveSettings(S.settings);
  $('#mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
  $('#mode-ab').setAttribute('aria-pressed', String(mode === 'ab'));
  $$('.loop-only').forEach((el) => { el.hidden = mode !== 'loop'; });
  $$('.ab-only').forEach((el) => { el.hidden = mode !== 'ab'; });
  $('#places-label').textContent = mode === 'loop' ? 'Départ et arrivée' : 'Itinéraire';
  renderHome();
  if (mode === 'ab') refreshFast();
}

function renderHome() {
  const s = S.settings;
  $('#duration-out').textContent = fmtDuration(s.durationMin);
  $('#wish-out').textContent = fmtDuration(s.wishMin);
  $('#max-out').textContent = fmtDuration(s.maxMin);
  $('#discovery').value = s.discovery;
  $('#discovery-out').textContent = s.discovery + ' %';
  $('#fuel').value = s.fuelKm;
  const d = s.discovery;
  const dur = fmtDuration(s.durationMin);
  $('#discovery-hint').textContent =
    d <= 15 ? `Une boucle simple et roulante, dans tes ${dur}.`
      : d <= 45 ? `Quelques détours pour le plaisir, dans tes ${dur}.`
        : d <= 75 ? `On cherche les virages et les points de vue, en restant dans tes ${dur}.`
          : `Priorité aux virages et aux panoramas, dans tes ${dur}.`;
  // A→B : repères de durée.
  const ticks = $('#ab-ticks').children;
  if (S.fast) {
    const fastMin = S.fast.timeS / 60;
    const t = (x) => fmtDuration(abTargetMinutes(fastMin, s.wishMin, s.maxMin, x));
    ticks[0].innerHTML = '0 %<br>' + t(0);
    ticks[1].innerHTML = '50 %<br>' + t(0.5);
    ticks[2].innerHTML = '100 %<br>' + t(1);
    $('#target-out').textContent = t(d / 100);
    $('#fast-info span').textContent = `Le plus rapide : ${fmtDuration(fastMin)} · ${Math.round(S.fast.lengthKm)} km`;
  } else {
    for (const [i, p] of ['0 %', '50 %', '100 %'].entries()) ticks[i].innerHTML = p + '<br>—';
    $('#target-out').textContent = '—';
    $('#fast-info span').textContent = S.end ? 'Calcul du trajet le plus rapide…' : 'Le plus rapide : choisis une arrivée';
  }
}

let fastTimer = null;
function refreshFast() {
  clearTimeout(fastTimer);
  if (S.settings.mode !== 'ab' || !S.end) { S.fast = null; renderHome(); return; }
  const a = startPoint();
  if (!a) return;
  const key = a.map((v) => v.toFixed(3)).join() + '|' + S.end.point.map((v) => v.toFixed(3)).join();
  if (S.fast && S.fast.key === key) return;
  S.fast = null;
  renderHome();
  fastTimer = setTimeout(async () => {
    try {
      const r = await fetchRoute([{ lat: a[0], lon: a[1] }, { lat: S.end.point[0], lon: S.end.point[1] }], S.settings);
      S.fast = { key, timeS: r.timeS, lengthKm: r.lengthKm };
      // Durées par défaut cohérentes avec le trajet.
      const fastMin = r.timeS / 60;
      if (S.settings.wishMin < fastMin) S.settings.wishMin = Math.ceil(fastMin * 1.5 / 15) * 15;
      if (S.settings.maxMin < S.settings.wishMin) S.settings.maxMin = Math.ceil(fastMin * 3 / 15) * 15;
      saveSettings(S.settings);
    } catch (e) {
      $('#fast-info span').textContent = e.message;
      return;
    }
    renderHome();
  }, 400);
}

function bindStepper() {
  $$('[data-step]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.step, delta = +b.dataset.delta;
    const s = S.settings;
    if (k === 'duration') s.durationMin = Math.min(600, Math.max(30, s.durationMin + delta));
    if (k === 'wish') { s.wishMin = Math.min(720, Math.max(15, s.wishMin + delta)); if (s.maxMin < s.wishMin) s.maxMin = s.wishMin; }
    if (k === 'max') { s.maxMin = Math.min(900, Math.max(30, s.maxMin + delta)); if (s.wishMin > s.maxMin) s.wishMin = s.maxMin; }
    saveSettings(s);
    renderHome();
  }));
}

// Champ de lieu avec suggestions (Photon).
function bindPlace(row, which) {
  const input = row.querySelector('input');
  const box = row.querySelector('.suggest');
  let timer = null, ctrl = null, items = [];
  const close = () => { box.hidden = true; };
  const render = () => {
    const list = [];
    if (which === 'start') list.push({ gps: true, label: 'Ma position actuelle', sub: S.gps ? 'GPS' : 'en attente du GPS' });
    list.push(...items);
    box.innerHTML = list.map((it, i) => `<button type="button" data-i="${i}"><b>${escapeHtml(it.label)}</b>${it.sub ? `<span>${escapeHtml(it.sub)}</span>` : ''}</button>`).join('');
    box.hidden = list.length === 0;
    box.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (ev) => ev.preventDefault()));
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const it = list[+b.dataset.i];
      if (which === 'start') {
        S.start = it.gps ? { gps: true, label: 'Ma position actuelle', point: null } : { gps: false, label: it.label, point: it.point };
        input.value = S.start.label;
        updateGpsChip();
      } else {
        S.end = { label: it.label, point: it.point };
        input.value = it.label;
      }
      close();
      input.blur();
      refreshFast();
    }));
  };
  input.addEventListener('focus', () => { input.select(); items = []; render(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { items = []; render(); return; }
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        items = await searchPlaces(q, startPoint() || S.gps?.pos, { signal: ctrl.signal });
        render();
      } catch (e) {
        if (e.name !== 'AbortError') { items = [{ label: 'Recherche indisponible', sub: e.message, point: null }]; render(); }
      }
    }, 350);
  });
}

// --- Réglages ----------------------------------------------------------------

function renderSettings() {
  const s = S.settings;
  $$('[data-setting]').forEach((el) => {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  });
  $$('[data-pause-type]').forEach((b) => b.setAttribute('aria-pressed', String(!!s.pauseTypes[b.dataset.pauseType])));
  $$('[data-avoid]').forEach((el) => { el.checked = !!s.avoid[el.dataset.avoid]; });
  $$('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', String(s.theme === b.dataset.theme)));
}

function bindSettings() {
  $$('[data-setting]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.setting;
    if (el.type === 'checkbox') S.settings[k] = el.checked;
    else {
      const v = parseFloat(el.value);
      if (Number.isFinite(v)) S.settings[k] = Math.max(+el.min || 0, Math.min(+el.max || 9999, v));
      el.value = S.settings[k];
    }
    saveSettings(S.settings);
  }));
  $$('[data-pause-type]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.pauseType;
    S.settings.pauseTypes[k] = !S.settings.pauseTypes[k];
    saveSettings(S.settings);
    renderSettings();
  }));
  $$('[data-avoid]').forEach((el) => el.addEventListener('change', () => {
    S.settings.avoid[el.dataset.avoid] = el.checked;
    saveSettings(S.settings);
    S.fast = null;
  }));
  $$('[data-theme]').forEach((b) => b.addEventListener('click', () => {
    S.settings.theme = b.dataset.theme;
    saveSettings(S.settings);
    renderSettings();
  }));
}

// --- Recherche (écran 2a) ----------------------------------------------------

const STEP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" style="color:#fff"><use href="#i-check"/></svg>';

function renderSteps(st) {
  const rows = [];
  if (st.mode === 'ab') rows.push({ key: 'ref', txt: 'Trajet le plus rapide', val: st.fastS ? fmtDuration(st.fastS / 60) : '' });
  rows.push({ key: 'poi', txt: 'Cols, belvédères et lacs repérés', val: st.poiCount != null ? String(st.poiCount) : '' });
  rows.push({ key: 'cand', txt: 'Calcul des parcours', val: st.total ? `${st.done} sur ${st.total}` : '', bar: st.total ? st.done / st.total : 0 });
  rows.push({ key: 'stops', txt: 'Pauses et plein d\'essence', val: '' });
  rows.push({ key: 'select', txt: 'Choix des meilleurs parcours', val: '' });
  const order = rows.map((r) => r.key);
  const cur = order.indexOf(st.phase);
  $('#search-steps').innerHTML = rows.map((r, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'active' : 'todo';
    return `<li class="${cls}"><div class="line"><span class="dot">${cls === 'done' ? STEP_ICON : ''}</span><span class="txt">${r.txt}</span><span class="val">${escapeHtml(r.val)}</span></div>${r.key === 'cand' && cls === 'active' ? `<div class="bar"><i style="width:${Math.round(r.bar * 100)}%"></i></div>` : ''}</li>`;
  }).join('');
}

const CAND_COLORS = ['#C2410C', '#0B6E6E', '#15181B', '#9A3412', '#0A5C5C', '#5B6168'];

async function startSearch() {
  const s = S.settings;
  const start = startPoint();
  if (!start) {
    toast(S.gpsError ? S.gpsError + ' : choisis un départ dans la liste' : 'En attente du GPS… réessaie dans un instant');
    return;
  }
  if (s.mode === 'ab' && !S.end) { toast('Choisis une arrivée'); $('#end-input').focus(); return; }
  s.fuelKm = Math.max(0, parseFloat($('#fuel').value) || 0);
  saveSettings(s);

  const p = {
    mode: s.mode,
    start,
    end: S.end?.point,
    durationMin: s.durationMin,
    wishMin: s.wishMin,
    maxMin: s.maxMin,
    discovery: s.discovery / 100,
    fuelKm: s.fuelKm,
    settings: JSON.parse(JSON.stringify(s)),
    departure: new Date(),
  };
  S.plan = { params: p, controller: new AbortController(), control: { stopEarly: false }, st: { mode: p.mode, phase: p.mode === 'ab' ? 'ref' : 'poi', done: 0, total: 0, found: 0 } };
  $('#search-sub').textContent = p.mode === 'loop'
    ? `Boucle · ${fmtDuration(p.durationMin)} de roulage · découverte ${s.discovery} %`
    : `Vers ${S.end.label} · découverte ${s.discovery} %`;
  $('#search-error').hidden = true;
  $('#search-error-actions').hidden = true;
  $('#search-note').hidden = false;
  const early = $('#search-early');
  early.hidden = false; early.disabled = true; early.textContent = 'Voir les parcours trouvés';
  renderSteps(S.plan.st);
  show('screen-search');

  if (!S.maps.search) S.maps.search = createMap('search-map', { interactive: false });
  const map = S.maps.search;
  if (S.searchLayer) S.searchLayer.remove();
  S.searchLayer = L.layerGroup().addTo(map);
  L.marker(start, { icon: markerIcon('start', 'start'), keyboard: false }).addTo(S.searchLayer);
  if (p.end) L.marker(p.end, { icon: markerIcon('end', 'start'), keyboard: false }).addTo(S.searchLayer);
  map.setView(start, p.mode === 'loop' ? 10 : 9);
  if (p.end) map.fitBounds([start, p.end], { padding: [40, 40] });
  setTimeout(() => map.invalidateSize(), 60);

  const plan = S.plan;
  let drawn = 0;
  try {
    const res = await planRoutes(p, {
      signal: plan.controller.signal,
      control: plan.control,
      onProgress: (e) => {
        const st = plan.st;
        if (e.phase === 'reference-done') { st.fastS = e.fastS; st.phase = 'poi'; S.fast = { key: 'x', timeS: e.fastS, lengthKm: e.route.lengthKm }; }
        if (e.phase === 'poi-done') { st.poiCount = e.count; st.phase = 'cand'; }
        if (e.phase === 'candidates') { st.phase = 'cand'; st.total = e.total; st.done = e.done; }
        if (e.phase === 'candidate') {
          st.done = e.done; st.total = e.total; st.found = e.found;
          const layer = routeLayer(e.route, { color: CAND_COLORS[drawn++ % CAND_COLORS.length], weight: 3, casing: null, opacity: 0.75 });
          layer.addTo(S.searchLayer);
          if (drawn === 1) map.fitBounds(L.latLngBounds(e.route.shape), { padding: [20, 20] });
          if (e.found >= 2) early.disabled = false;
        }
        if (e.phase === 'stops') st.phase = 'stops';
        if (e.phase === 'select') st.phase = st.phase === 'stops' ? 'stops' : 'select';
        if (e.phase === 'done') st.phase = 'done';
        renderSteps(st);
      },
    });
    if (S.plan !== plan) return;
    S.result = res;
    renderList();
    show('screen-list');
  } catch (e) {
    if (e instanceof AbortedError || S.plan !== plan) return;
    $('#search-error').textContent = e.message || 'Erreur inattendue';
    $('#search-error').hidden = false;
    $('#search-error-actions').hidden = false;
    $('#search-note').hidden = true;
    early.hidden = true;
  }
}

// --- Liste (écran 2b) --------------------------------------------------------

function dotsHtml(n) {
  return `<span class="dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}

function renderList() {
  const p = S.plan.params;
  $('#list-sub').textContent = (p.mode === 'loop'
    ? `Boucle · ${fmtDuration(p.durationMin)} de roulage`
    : `Vers ${S.end.label}`) + ` · découverte ${Math.round(p.discovery * 100)} % · ${p.fuelKm} km d'autonomie`;
  const html = S.result.options.map((o, i) => {
    const m = o.metrics;
    const pauses = o.stops.length;
    const fuel = o.stops.filter((s) => s.kind === 'fuel').length;
    return `<button type="button" class="route-card ${i === 0 ? 'best' : ''}" data-i="${i}">
      ${thumbSvg(o.route.shape, o.start)}
      <span class="body">
        ${o.badge ? `<span class="badge ${o.badge.tone}">${escapeHtml(o.badge.label)}</span>` : ''}
        <span class="route-name">${escapeHtml(o.name)}</span>
        <span class="route-dur">${fmtDuration(o.route.timeS / 60)} · ${Math.round(o.route.totalM / 1000)} km</span>
        <span class="indics">
          <span class="indic" role="img" aria-label="Virages : ${m.curvRating} sur 5"><svg aria-hidden="true" style="color:var(--accent)"><use href="#i-logo"/></svg>${dotsHtml(m.curvRating)}</span>
          <span class="indic" role="img" aria-label="${m.panoramaCount} panoramas"><svg aria-hidden="true" style="color:var(--teal)"><use href="#i-mountain"/></svg>${m.panoramaCount}</span>
          <span class="indic" role="img" aria-label="${pauses} pauses dont ${fuel} plein"><svg aria-hidden="true"><use href="#i-cup"/></svg>${pauses}${fuel ? ' · ' + fuel + ' plein' : ''}</span>
        </span>
        ${o.fuelWarning ? `<span class="warn-line">${escapeHtml(o.fuelWarning.message)}</span>` : ''}
      </span>
    </button>`;
  }).join('') + '<button type="button" class="btn-link" id="list-again">Changer les réglages et relancer</button>';
  $('#route-list').innerHTML = html;
  $$('#route-list .route-card').forEach((b) => b.addEventListener('click', () => openDetail(S.result.options[+b.dataset.i])));
  $('#list-again').addEventListener('click', () => { S.history = ['screen-home']; show('screen-home', { push: false }); });
}

// --- Détail (écran 2c) -------------------------------------------------------

const STOP_ICON = { cafe: 'i-cup', restaurant: 'i-fork', viewpoint: 'i-mountain', picnic: 'i-tree', fuel: 'i-fuel' };
const SIGHT_ICON = { pass: 'i-mountain', viewpoint: 'i-mountain', lake: 'i-water', waterfall: 'i-water', castle: 'i-castle' };
const SIGHT_LABEL = { pass: 'Col', viewpoint: 'Belvédère', lake: 'Lac', waterfall: 'Cascade', castle: 'Château' };

function renderDetail() {
  const o = S.option;
  const r = o.route;
  const m = o.metrics;
  const pauseS = o.stops.reduce((a, s) => a + s.durationS, 0);
  $('#detail-title').textContent = o.name;
  $('#detail-stats').innerHTML = `<b>${fmtDuration(r.timeS / 60)}</b> de roulage${pauseS ? ` + ${fmtDuration(pauseS / 60)} de pauses` : ''} · <b>${Math.round(r.totalM / 1000)} km</b>`;
  const ret = new Date(Date.now() + (r.timeS + pauseS) * 1000);
  const bits = [`Virages ${m.curvRating}/5`, `${m.panoramaCount} panorama${m.panoramaCount > 1 ? 's' : ''}`];
  if (m.highest) bits.push(`point culminant ${m.highest.name} ${m.highest.ele.toLocaleString('fr-FR')} m`);
  bits.push((o.mode === 'loop' ? 'retour' : 'arrivée') + ' vers ' + fmtClock(ret));
  $('#detail-sub').textContent = bits.join(' · ');
  $('#detail-warn').hidden = !o.fuelWarning;
  if (o.fuelWarning) $('#detail-warn').textContent = o.fuelWarning.message;

  // Programme : départ, pauses, points de vue en passant, arrivée.
  const items = [{ t: 0, html: `<span class="tl-ico"><svg aria-hidden="true" style="color:#fff"><use href="#i-flag"/></svg></span><span class="tl-txt"><b>Départ</b><span>${escapeHtml(o.mode === 'loop' || S.start.gps ? S.start.label : S.start.label)}</span></span>`, along: 0 }];
  for (const s of o.stops) {
    const cls = s.kind === 'fuel' ? 'accent' : 'teal';
    const icon = s.kind === 'fuel' ? 'i-fuel' : STOP_ICON[s.poiKind] || 'i-cup';
    const extra = s.distFromRoute > 150 ? ` · à ${Math.round(s.distFromRoute / 10) * 10} m` : '';
    items.push({ t: s.timeS, along: s.along, html: `<span class="tl-ico ${cls}"><svg aria-hidden="true" style="color:#fff"><use href="#${icon}"/></svg></span><span class="tl-txt"><b>${escapeHtml(s.label)} · ${Math.round(s.durationS / 60)} min</b><span>${escapeHtml(s.name)} · km ${Math.round(s.along / 1000)}${extra}</span></span>` });
  }
  const sights = m.sights.filter((x) => x.kind !== 'lake' || x.name)
    .filter((x) => !o.stops.some((s) => Math.abs(s.along - x.along) < 2000))
    .sort((a, b) => b.weight - a.weight).slice(0, 3);
  for (const x of sights) {
    const t = timeAt(r, x.along);
    const nm = x.name || SIGHT_LABEL[x.kind];
    items.push({ t, along: x.along, muted: true, html: `<span class="tl-ico ring"><svg aria-hidden="true" style="color:var(--teal)"><use href="#${SIGHT_ICON[x.kind]}"/></svg></span><span class="tl-txt"><b style="font-weight:600">${escapeHtml(SIGHT_LABEL[x.kind])}, en passant</b><span>${escapeHtml(x.name && x.name !== nm ? x.name : (x.name || ''))}${x.ele ? ' · ' + x.ele + ' m' : ''}${x.name ? ' · ' : ''}km ${Math.round(x.along / 1000)}</span></span>` });
  }
  items.sort((a, b) => a.along - b.along);
  items.push({ t: r.timeS, html: `<span class="tl-ico"><svg aria-hidden="true" style="color:#fff"><use href="#i-check"/></svg></span><span class="tl-txt"><b>${o.mode === 'loop' ? 'Retour au départ' : 'Arrivée'}</b><span>km ${Math.round(r.totalM / 1000)}</span></span>` });
  $('#detail-timeline').innerHTML = items.map((it) => `<li><span class="t ${it.muted ? 'muted' : ''}">${fmtClockDelta(it.t)}</span>${it.html}</li>`).join('');

  // Carte.
  if (!S.maps.detail) S.maps.detail = createMap('detail-map');
  const map = S.maps.detail;
  if (S.detailLayer) S.detailLayer.remove();
  const g = L.layerGroup().addTo(map);
  routeLayer(r).addTo(g);
  L.marker(o.start, { icon: markerIcon('start', 'start'), keyboard: false }).addTo(g);
  if (o.mode === 'ab') L.marker(o.end, { icon: markerIcon('end', 'start'), keyboard: false }).addTo(g);
  for (const x of sights) L.marker(x.point, { icon: markerIcon('viewpoint', 'sight'), keyboard: false, title: x.name || SIGHT_LABEL[x.kind] }).addTo(g);
  for (const s of o.stops) stopMarker(s).addTo(g);
  S.detailLayer = g;
  setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(r.shape), { padding: [24, 24] }); }, 60);
}

async function openDetail(option) {
  S.option = option;
  show('screen-detail');
  renderDetail();
  // Recalcul en passant par les pauses, pour que le guidage y mène.
  if (option.stops.length && !option.withStops) {
    const go = $('#detail-go');
    const upd = $('#detail-updating');
    upd.hidden = false; go.disabled = true; $('#detail-sim').disabled = true;
    try {
      const r = await routeWithStops(option, S.plan.params.settings);
      option.route = r;
      option.metrics = { ...option.metrics, ...analyzeRoute(r, S.result.pois, option.mode), curvRating: option.metrics.curvRating };
      option.withStops = true;
      if (S.option === option) renderDetail();
    } catch (e) {
      toast('Guidage vers les pauses indisponible, elles seront signalées en chemin');
    } finally {
      upd.hidden = true; go.disabled = false; $('#detail-sim').disabled = false;
    }
  }
}

// --- Navigation (écran 3) -----------------------------------------------------

const MAN_ICONS = {
  straight: '<path d="M12 21V4"/><path d="M7 9l5-5 5 5"/>',
  right: '<path d="M7 21V11a4 4 0 0 1 4-4h8"/><path d="M15 3l4 4-4 4"/>',
  left: '<path d="M17 21V11a4 4 0 0 0-4-4H5"/><path d="M9 3L5 7l4 4"/>',
  slightRight: '<path d="M8 21v-7c0-3 2-5 5-7l4-3"/><path d="M12 3h6v6"/>',
  slightLeft: '<path d="M16 21v-7c0-3-2-5-5-7L7 4"/><path d="M12 3H6v6"/>',
  sharpRight: '<path d="M8 21V7a3 3 0 0 1 6 0v0l4 10"/><path d="M14 16l4 1 1-4"/>',
  sharpLeft: '<path d="M16 21V7a3 3 0 0 0-6 0v0L6 17"/><path d="M10 16l-4 1-1-4"/>',
  uturn: '<path d="M8 21V9a4 4 0 0 1 8 0v6"/><path d="M12 12l4 4 4-4"/>',
  roundabout: '<circle cx="12" cy="9" r="4"/><path d="M12 13v8"/><path d="M15 6l3-3"/><path d="M15 3h3v3"/>',
  arrive: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
};

function maneuverIcon(type) {
  if ([9, 18, 20, 23, 36].includes(type)) return MAN_ICONS.slightRight;
  if ([16, 19, 21, 24, 37].includes(type)) return MAN_ICONS.slightLeft;
  if ([10, 2].includes(type)) return MAN_ICONS.right;
  if ([15, 3].includes(type)) return MAN_ICONS.left;
  if (type === 11) return MAN_ICONS.sharpRight;
  if (type === 14) return MAN_ICONS.sharpLeft;
  if ([12, 13].includes(type)) return MAN_ICONS.uturn;
  if ([26, 27].includes(type)) return MAN_ICONS.roundabout;
  if ([4, 5, 6].includes(type)) return MAN_ICONS.arrive;
  return MAN_ICONS.straight;
}

function shortText(m) {
  const t = m.type;
  if ([10, 2].includes(t)) return 'Tourne à droite';
  if ([15, 3].includes(t)) return 'Tourne à gauche';
  if ([9, 23, 36].includes(t)) return 'Serre à droite';
  if ([16, 24, 37].includes(t)) return 'Serre à gauche';
  if (t === 11) return 'Tourne franchement à droite';
  if (t === 14) return 'Tourne franchement à gauche';
  if ([12, 13].includes(t)) return 'Fais demi-tour';
  if (t === 26) return m.exit ? `Au rond-point, ${m.exit}${m.exit === 1 ? 're' : 'e'} sortie` : 'Prends le rond-point';
  if (t === 27) return 'Sors du rond-point';
  if ([18, 20].includes(t)) return 'Sors à droite';
  if ([19, 21].includes(t)) return 'Sors à gauche';
  if ([4, 5, 6].includes(t)) return 'Arrivée';
  if (t === 1) return 'Pars';
  return 'Continue';
}

function navTheme() {
  const t = S.settings.theme;
  if (t === 'day' || t === 'night') return t;
  const p = startPoint() || [45, 7];
  return isNight(new Date(), p[0], p[1]) ? 'night' : 'day';
}

let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* refusé */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.nav && !S.nav.engine.finished) keepAwake();
});

function startNav({ simulate = false } = {}) {
  const o = S.option;
  if (!o) return;
  unlockVoice();
  setVoiceEnabled(S.settings.voice);
  keepAwake();
  const theme = navTheme();
  const scr = $('#screen-nav');
  scr.classList.toggle('light', theme === 'day');
  o.fuelKm = S.plan.params.fuelKm;
  const nav = { follow: true, simulate, theme };
  S.nav = nav;
  const engine = new NavEngine(o, S.settings, {
    onUpdate: (st) => updateNav(st),
    onSpeak: (txt, prio) => speak(txt, prio),
    onStopPrompt: (stop) => { if (stop) showStopSheet(stop); else hideSheet(); },
    onStopArrive: (stop) => showPauseSheet(stop),
    onRerouteState: (st) => rerouteState(st),
    onRouteChanged: (r) => drawNavRoute(r),
    onArrive: (sum) => endNav(sum),
  });
  nav.engine = engine;
  $('#sim-badge').hidden = !simulate;
  $('#nav-voice').setAttribute('aria-pressed', String(!!S.settings.voice));
  hideSheet();
  $('#offroute').hidden = true;
  show('screen-nav');

  if (!S.maps.nav) {
    S.maps.nav = createMap('nav-map', { rotate: true, theme });
    S.maps.nav.on('dragstart', () => { if (S.nav) S.nav.follow = false; });
  } else setTheme(S.maps.nav, theme);
  const map = S.maps.nav;
  map.setBearing(0);
  drawNavRoute(o.route);
  map.setView(o.start, 15);
  setTimeout(() => map.invalidateSize(), 60);

  if (simulate) {
    nav.sim = new Simulator(engine, { factor: 4 });
    nav.sim.start();
  } else {
    const onFix = (p) => engine.feed({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp });
    nav.onFix = onFix;
    gpsListeners.add(onFix);
    startGps(true);
    if (S.gps) engine.feed({ lat: S.gps.pos[0], lon: S.gps.pos[1], accuracy: S.gps.accuracy, speed: S.gps.speed, heading: S.gps.heading, t: Date.now() });
  }
  speak(`C'est parti pour ${o.name}.`);
}

function drawNavRoute(r) {
  const map = S.maps.nav;
  if (S.navLayer) S.navLayer.remove();
  const g = L.layerGroup().addTo(map);
  const dark = S.nav?.theme === 'night';
  routeLayer(r, { color: dark ? '#FB8A3C' : '#C2410C', weight: 8, casing: dark ? '#111417' : '#FFFFFF' }).addTo(g);
  for (const s of S.nav?.engine?.stops || S.option.stops) stopMarker(s).addTo(g);
  S.navLayer = g;
  if (!S.meMarker) S.meMarker = L.marker(r.shape[0], { icon: meIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 });
  S.meMarker.addTo(map);
}

function updateNav(st) {
  const nav = S.nav;
  if (!nav) return;
  const map = S.maps.nav;
  // Manœuvre.
  const nm = st.maneuver;
  if (nm) {
    $('#man-icon').innerHTML = `<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${maneuverIcon(nm.m.type)}</g>`;
    $('#man-icon').setAttribute('aria-label', shortText(nm.m));
    $('#man-dist').textContent = fmtDist(nm.dist);
    $('#man-text').textContent = shortText(nm.m);
    const street = nm.m.streets?.[0];
    $('#man-street').textContent = street ? (nm.m.type === 8 && nm.m.instruction.startsWith('Reprenez') ? nm.m.instruction : street) : '';
    const f = nm.following;
    if (f && f.gap < 2000 && ![4, 5, 6].includes(f.m.type)) {
      $('#man-next').hidden = false;
      $('#man-next').innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${maneuverIcon(f.m.type)}</g></svg>Puis ${escapeHtml(shortText(f.m).toLowerCase())} ${f.gap < 120 ? 'juste après' : 'dans ' + fmtDist(f.gap)}`;
    } else $('#man-next').hidden = true;
  }
  // Vitesse et résumé.
  $('#nav-speed').textContent = Math.round((st.speed || 0) * 3.6);
  $('#nav-eta').textContent = fmtClock(st.eta);
  $('#nav-eta-label').textContent = S.option.mode === 'loop' ? 'retour' : 'arrivée';
  $('#nav-left-km').textContent = fmtKm(st.leftM);
  $('#nav-left-time').textContent = fmtDuration(st.leftRideS / 60);
  // Prochaine pause.
  const ns = st.nextStop;
  const btn = $('#nav-next-stop');
  if (ns) {
    const s = ns.stop;
    const when = ns.inS < 90 ? fmtDist(Math.max(0, ns.aheadM)) : fmtDuration(ns.inS / 60);
    const icon = s.kind === 'fuel' ? 'i-fuel' : STOP_ICON[s.poiKind] || 'i-cup';
    btn.innerHTML = `<svg aria-hidden="true"><use href="#${icon}"/></svg><span class="grow">${escapeHtml(s.label)} dans <b>${when}</b>${s.state === 'accepted' ? ' · prévue' : ''}</span><small>km ${Math.round(s.along / 1000 + 0)}</small>`;
    btn.hidden = false; $('#nav-next-gap').hidden = false;
    btn.onclick = () => showStopSheet(s, true);
  } else { btn.hidden = true; $('#nav-next-gap').hidden = true; }
  // Carburant.
  const fuel = Math.max(0, st.fuelLeftKm);
  $('#nav-fuel').textContent = `Autonomie ≈ ${Math.round(fuel)} km`;
  $('#nav-fuel-next').textContent = st.nextFuelKm != null ? `plein dans ${Math.round(st.nextFuelKm)} km` : (fuel - S.settings.safetyKm < st.leftM / 1000 ? 'pense au plein !' : '');
  $('#nav-fuel-gauge').style.width = Math.max(2, Math.min(100, (fuel / S.settings.fullTankKm) * 100)) + '%';
  // Carte.
  if (st.pos) {
    S.meMarker.setLatLng(st.pos);
    if (nav.follow) {
      const z = st.speed > 20 ? 15 : st.speed > 9 ? 16 : 17;
      const zoom = nm && nm.dist < 300 ? 17 : z;
      if (st.speed > 2 || !nav.bearingSet) {
        map.setBearing(-(st.heading || 0));
        nav.bearingSet = true;
      }
      const zoomChanged = map.getZoom() !== zoom;
      map.setView(aheadCenter(map, st.pos, st.heading || 0), zoom, zoomChanged ? { animate: false } : { animate: true, duration: 0.8, easeLinearity: 1 });
    }
    // La flèche suit le cap relativement à la carte (carte orientée dans le sens de la marche).
    const el = S.meMarker.getElement();
    if (el) {
      const rot = (st.heading || 0) + (map.getBearing ? map.getBearing() : 0);
      const svg = el.querySelector('svg');
      if (svg) svg.style.transform = `rotate(${rot}deg)`;
    }
  }
}

function rerouteState(st) {
  const box = $('#offroute');
  if (st === 'off') { box.hidden = false; box.textContent = 'Hors parcours'; }
  if (st === 'rerouting') { box.hidden = false; box.textContent = 'Hors parcours — recalcul…'; }
  if (st === 'done' || st === 'ok') { box.hidden = true; if (st === 'done') toast('Nouvel itinéraire pour rejoindre le parcours'); }
  if (st === 'failed') {
    const e = S.nav?.engine;
    let txt = 'Recalcul impossible (réseau ?)';
    if (e?.pos) {
      const r = e.route;
      const target = r.shape[Math.min(r.shape.length - 1, e.matchIdx + 5)];
      const d = haversine(e.pos, target);
      const dirs = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
      txt += ` — parcours à ${fmtDist(d)} vers le ${dirs[Math.round(bearing(e.pos, target) / 45) % 8]}`;
    }
    box.hidden = false; box.textContent = txt;
  }
}

function hideSheet() {
  $('#nav-sheet').hidden = true;
  $('#nav-sheet').innerHTML = '';
  $('#nav-main').hidden = false;
}

function sheet(html) {
  $('#nav-main').hidden = true;
  const el = $('#nav-sheet');
  el.innerHTML = html;
  el.hidden = false;
  return el;
}

function showStopSheet(stop, manual = false) {
  const e = S.nav.engine;
  const st = e.state();
  const rode = fmtDuration(e.movingS / 60);
  const fuel = Math.round(Math.max(0, e.fuelLeftKm));
  const icon = stop.kind === 'fuel' ? 'i-fuel' : STOP_ICON[stop.poiKind] || 'i-cup';
  const ahead = Math.max(0, stop.along - st.along);
  let text = `Tu roules depuis <b>${rode}</b>.`;
  if (stop.kind === 'fuel') text += ` Il te reste environ <b style="color:var(--n-accent)">${fuel} km</b> d'autonomie : c'est le bon moment pour faire le plein.`;
  let warn = '';
  if (stop.kind === 'fuel') {
    const later = e.stops.find((s) => s !== stop && s.kind === 'fuel' && s.along > stop.along);
    const reach = fuel - S.settings.safetyKm;
    if (!later && st.leftM / 1000 - ahead / 1000 > reach) warn = `Pas d'autre station prévue sur le parcours : sans plein ici, tu entameras ta marge de sécurité.`;
  }
  const nextAfter = e.stops.find((s) => s !== stop && s.along > stop.along && ['pending', 'prompted'].includes(s.state));
  const el = sheet(`
    <div class="sheet-head"><div class="sheet-ico"><svg aria-hidden="true"><use href="#${icon}"/></svg></div>
      <div style="min-width:0"><h2>${escapeHtml(stop.label)}</h2><div class="sub">${escapeHtml(stop.name)} · ${Math.round(stop.durationS / 60)} min · dans ${fmtDist(ahead)}</div></div></div>
    <p>${text}</p>
    ${warn ? `<div class="warn"><svg aria-hidden="true"><use href="#i-warn"/></svg><span>${warn}</span></div>` : ''}
    <button class="nav-btn primary" type="button" data-act="accept">On s'arrête</button>
    <div class="btn-row"><button class="nav-btn" type="button" data-act="here">Pause ici</button><button class="nav-btn" type="button" data-act="skip">Pas cette fois</button></div>
    ${nextAfter ? `<div class="foot">Pause suivante : ${escapeHtml(nextAfter.label.toLowerCase())}, dans ${fmtDuration(Math.max(0, nextAfter.timeS - stop.timeS) / 60)} environ</div>` : ''}
  `);
  el.querySelector('[data-act="accept"]').onclick = () => { e.acceptStop(stop); hideSheet(); toast('Pause prévue : on t\'y guide'); };
  el.querySelector('[data-act="skip"]').onclick = () => { e.skipStop(stop); hideSheet(); };
  el.querySelector('[data-act="here"]').onclick = () => { e.acceptStop(stop); e.startPauseHere(stop); showPauseSheet(stop); };
  void manual;
}

let pauseTimer = null;
function showPauseSheet(stop) {
  const e = S.nav.engine;
  const el = sheet(`
    <div class="sheet-head"><div class="sheet-ico"><svg aria-hidden="true"><use href="#${stop.kind === 'fuel' ? 'i-fuel' : 'i-cup'}"/></svg></div>
      <div><h2>En pause</h2><div class="sub">${escapeHtml(stop.name)} · prévu ${Math.round(stop.durationS / 60)} min</div></div></div>
    <div class="timer" id="pause-timer">0:00</div>
    ${stop.kind === 'fuel' ? '<p style="text-align:center">N\'oublie pas le plein : l\'autonomie repartira à ' + S.settings.fullTankKm + ' km.</p>' : ''}
    <button class="nav-btn primary" type="button" data-act="resume">Reprendre la route</button>
  `);
  clearInterval(pauseTimer);
  const t0 = e.pausedAt || Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const node = document.getElementById('pause-timer');
    if (node) node.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  tick();
  pauseTimer = setInterval(tick, 1000);
  speak(stop.kind === 'fuel' ? 'Vous êtes à la station. Bonne pause !' : 'Bonne pause !');
  el.querySelector('[data-act="resume"]').onclick = () => {
    clearInterval(pauseTimer);
    e.resume();
    hideSheet();
    speak('On reprend la route.');
  };
}

function showOptions() {
  const nav = S.nav;
  const sim = nav.sim;
  const el = sheet(`
    <div class="row-between"><h2>Options</h2><button class="nav-tool" type="button" data-act="close" aria-label="Fermer"><svg aria-hidden="true"><use href="#i-close"/></svg></button></div>
    <label class="opt-row">Instructions vocales<input type="checkbox" data-act="voice" ${S.settings.voice ? 'checked' : ''} style="width:24px;height:24px;accent-color:var(--n-accent)"></label>
    ${sim ? `<div class="opt-row">Vitesse de simulation<div class="seg3" role="group" aria-label="Vitesse de simulation">${[1, 4, 10].map((k) => `<button type="button" data-k="${k}" aria-pressed="${sim.factor === k}">×${k}</button>`).join('')}</div></div>
    <button class="nav-btn" type="button" data-act="deviate">Sortir du parcours (test du recalcul)</button>` : ''}
    <button class="nav-btn" type="button" data-act="overview">Voir tout le parcours</button>
    <button class="nav-btn" type="button" data-act="quit">Quitter la navigation</button>
  `);
  el.querySelector('[data-act="close"]').onclick = hideSheet;
  el.querySelector('[data-act="voice"]').onchange = (ev) => {
    S.settings.voice = ev.target.checked; saveSettings(S.settings);
    setVoiceEnabled(S.settings.voice);
    $('#nav-voice').setAttribute('aria-pressed', String(S.settings.voice));
  };
  el.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => { sim.setFactor(+b.dataset.k); showOptions(); }; });
  el.querySelector('[data-act="deviate"]')?.addEventListener('click', () => { sim.deviate(); hideSheet(); toast('On sort du parcours…'); });
  el.querySelector('[data-act="overview"]').onclick = () => {
    nav.follow = false;
    const map = S.maps.nav;
    map.setBearing(0);
    map.fitBounds(L.latLngBounds(nav.engine.route.shape), { padding: [30, 30] });
    hideSheet();
  };
  el.querySelector('[data-act="quit"]').onclick = () => confirmFinish();
}

function confirmFinish() {
  const el = sheet(`
    <h2>Terminer la sortie ?</h2>
    <p>Ta trace est enregistrée, tu pourras l'exporter.</p>
    <button class="nav-btn primary" type="button" data-act="yes">Oui, terminer</button>
    <button class="nav-btn" type="button" data-act="no">Continuer à rouler</button>
  `);
  el.querySelector('[data-act="yes"]').onclick = () => S.nav.engine.finish(false);
  el.querySelector('[data-act="no"]').onclick = hideSheet;
}

function stopNavResources() {
  const nav = S.nav;
  if (!nav) return;
  nav.sim?.stop();
  if (nav.onFix) gpsListeners.delete(nav.onFix);
  clearInterval(pauseTimer);
  try { wakeLock?.release(); } catch { /* déjà relâché */ }
  wakeLock = null;
  if ('speechSynthesis' in window) setTimeout(() => speechSynthesis.cancel(), 4000);
}

// --- Fin (écran 3c) -----------------------------------------------------------

function endNav(sum) {
  stopNavResources();
  S.summary = sum;
  const o = sum.option;
  $('#end-title').textContent = sum.arrived ? 'Belle virée !' : 'Sortie terminée';
  const d = new Date(sum.startedAt);
  $('#end-sub').textContent = `${o.name} · ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  const km = sum.odometerM / 1000;
  const avg = sum.movingS > 60 ? km / (sum.movingS / 3600) : 0;
  const cells = [
    [fmtKm(sum.odometerM), 'parcourus'],
    [fmtDuration(sum.movingS / 60), 'de roulage'],
    [Math.round(avg) + ' km/h', 'de moyenne'],
    [String(sum.pausesDone), sum.pausesDone > 1 ? 'pauses' : 'pause'],
    [String(o.metrics.panoramaCount), 'panoramas'],
    o.metrics.highest ? [o.metrics.highest.ele.toLocaleString('fr-FR') + ' m', 'point culminant'] : [String(sum.reroutes), 'recalculs'],
  ];
  $('#end-stats').innerHTML = cells.map(([v, l]) => `<div><dt>${l}</dt><dd>${v}</dd></div>`).join('');
  show('screen-end');
  if (!S.maps.end) S.maps.end = createMap('end-map', { interactive: false });
  const map = S.maps.end;
  if (S.endLayer) S.endLayer.remove();
  const g = L.layerGroup().addTo(map);
  routeLayer(o.route, { color: '#5B6168', weight: 3, casing: null, opacity: 0.5 }).addTo(g);
  if (sum.track.length > 1) L.polyline(sum.track.map((t) => [t[0], t[1]]), { color: '#C2410C', weight: 4 }).addTo(g);
  L.marker(o.start, { icon: markerIcon('start', 'start'), keyboard: false }).addTo(g);
  S.endLayer = g;
  setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(sum.track.length > 1 ? sum.track.map((t) => [t[0], t[1]]) : o.route.shape), { padding: [16, 16] }); }, 60);
  S.nav = null;
}

// --- Démarrage -----------------------------------------------------------------

async function init() {
  if (MOCK) {
    const mod = await import('../tests/mock-world.js');
    mod.installMock(window, { latency: 40 });
    setRateGap(+(params.get('gap') || 150));
  }
  initVoice();
  bindStepper();
  bindSettings();
  renderSettings();
  bindPlace($('[data-place="start"]'), 'start');
  bindPlace($('[data-place="end"]'), 'end');
  $('#start-input').value = S.start.label;
  setMode(S.settings.mode);

  $('#mode-loop').addEventListener('click', () => setMode('loop'));
  $('#mode-ab').addEventListener('click', () => setMode('ab'));
  $('#discovery').addEventListener('input', (e) => { S.settings.discovery = +e.target.value; renderHome(); });
  $('#discovery').addEventListener('change', () => saveSettings(S.settings));
  $('#fuel').addEventListener('change', (e) => { S.settings.fuelKm = Math.max(0, parseFloat(e.target.value) || 0); saveSettings(S.settings); });
  $('#home-form').addEventListener('submit', (e) => { e.preventDefault(); startSearch(); });
  $('#open-settings').addEventListener('click', () => { renderSettings(); show('screen-settings'); });
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => { back(); renderHome(); }));

  $('#search-cancel').addEventListener('click', () => { S.plan?.controller.abort(); S.plan = null; S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#search-early').addEventListener('click', () => { if (S.plan) { S.plan.control.stopEarly = true; $('#search-early').disabled = true; $('#search-early').textContent = 'Finalisation…'; } });
  $('#search-edit').addEventListener('click', () => { S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#search-retry').addEventListener('click', () => startSearch());
  $('#list-back').addEventListener('click', () => { S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#detail-back').addEventListener('click', () => { S.history = ['screen-home', 'screen-list']; show('screen-list', { push: false }); });
  $('#detail-others').addEventListener('click', () => { S.history = ['screen-home', 'screen-list']; show('screen-list', { push: false }); });
  $('#detail-go').addEventListener('click', () => startNav());
  $('#detail-sim').addEventListener('click', () => startNav({ simulate: true }));
  $('#detail-gpx').addEventListener('click', () => downloadText(slug(S.option.name) + '.gpx', routeGpx(S.option)));

  $('#nav-voice').addEventListener('click', () => {
    S.settings.voice = !S.settings.voice; saveSettings(S.settings);
    setVoiceEnabled(S.settings.voice);
    $('#nav-voice').setAttribute('aria-pressed', String(S.settings.voice));
    $('#nav-voice use').setAttribute('href', S.settings.voice ? '#i-volume' : '#i-mute');
    toast(S.settings.voice ? 'Voix activée' : 'Voix coupée', 1500);
  });
  $('#nav-recenter').addEventListener('click', () => { if (S.nav) { S.nav.follow = true; S.nav.bearingSet = false; } });
  $('#nav-options').addEventListener('click', showOptions);
  $('#nav-finish').addEventListener('click', confirmFinish);

  $('#end-gpx').addEventListener('click', () => {
    if (!S.summary || S.summary.track.length < 2) { toast('Trace trop courte pour être exportée'); return; }
    downloadText(slug(S.summary.option.name) + '-trace.gpx', trackGpx(S.summary.option.name, S.summary.track));
  });
  $('#end-route-gpx').addEventListener('click', () => S.summary && downloadText(slug(S.summary.option.name) + '.gpx', routeGpx(S.summary.option)));
  $('#end-new').addEventListener('click', () => { S.history = ['screen-home']; show('screen-home', { push: false }); });

  startGps();
  if (!MOCK && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__viree = S; // pratique pour le débogage
}

init();
