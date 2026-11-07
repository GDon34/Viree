// Virée — application (écrans, saisie, recherche, navigation).
/* global L */
import { loadSettings, saveSettings } from './settings.js';
import { PlanSession, routeWithStops, analyzeRoute, abTargetMinutes, featureVector } from './planner.js';
import {
  saveRide, listRides, deleteRide, rateRide, rideRecord, rideTrack, unpackOption,
  saveLiked, deleteLiked, listLiked, loadPrefs, resetPrefs, loadVotes, clearVotes, learn, recordVote,
  exclusionSets, TASTES,
} from './store.js';
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
  const m = { 'screen-detail': 'detail', 'screen-nav': 'nav', 'screen-end': 'end', 'screen-rides': 'rides' }[id];
  if (m && S.maps[m]) setTimeout(() => S.maps[m].invalidateSize(), 50);
  window.scrollTo(0, 0);
}

function back() {
  S.history.pop();
  show(S.history[S.history.length - 1] || 'screen-home', { push: false });
}

let toastTimer;
function toast(msg, ms = 3500, action = null) {
  const t = $('#toast');
  $('#toast-text').textContent = msg;
  const btn = $('#toast-action');
  if (action) {
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = () => { t.hidden = true; action.fn(); };
  } else btn.hidden = true;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// --- GPS ---------------------------------------------------------------------

let gpsWatch = null;
const gpsListeners = new Set();

function onGpsFix(p) {
  const fix = { pos: [p.coords.latitude, p.coords.longitude], accuracy: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, t: p.timestamp || Date.now() };
  // On garde la meilleure position récente (la première, approximative, est vite remplacée).
  if (!S.gps || fix.accuracy <= S.gps.accuracy * 1.5 || fix.t - S.gps.t > 15000) S.gps = fix;
  S.gpsError = null;
  updateGpsChip();
  if (!S.fast && S.settings.mode === 'ab' && S.end && !S.start.point) refreshFast();
  for (const f of gpsListeners) f(p);
}

function onGpsError(err) {
  if (err.code === 1) S.gpsError = 'denied';
  else if (!S.gps) S.gpsError = 'unavailable';
  updateGpsChip();
}

function startGps(force = false) {
  if (MOCK && !force) {
    const w = window.__mockWorld;
    S.gps = { pos: w.places[2].p, accuracy: 8, t: Date.now() };
    updateGpsChip();
    return;
  }
  if (!('geolocation' in navigator)) { S.gpsError = 'unsupported'; updateGpsChip(); return; }
  // Position approximative rapide (réseau), puis suivi précis par le GPS.
  navigator.geolocation.getCurrentPosition(onGpsFix, onGpsError, { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 });
  if (gpsWatch != null) return;
  gpsWatch = navigator.geolocation.watchPosition(onGpsFix, onGpsError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 60000 });
}

function restartGps() {
  if (gpsWatch != null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
  S.gpsError = null;
  updateGpsChip();
  startGps();
}

// Attend une position (au plus `ms` millisecondes).
function waitForGps(ms) {
  if (S.gps) return Promise.resolve(S.gps.pos);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (S.gps || S.gpsError === 'denied' || Date.now() - t0 > ms) { clearInterval(iv); resolve(S.gps ? S.gps.pos : null); }
    }, 250);
  });
}

const GPS_HELP = 'Position refusée. Dans Chrome : touche l\'icône à gauche de l\'adresse → Autorisations → Position → Autoriser. Vérifie aussi que la localisation du téléphone est activée.';

function updateGpsChip() {
  const chip = $('#gps-chip');
  if (!chip) return;
  if (!S.start.gps) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.remove('ok', 'approx', 'bad');
  const label = chip.querySelector('span');
  if (S.gpsError === 'denied' || S.gpsError === 'unsupported') {
    chip.classList.add('bad'); label.textContent = 'GPS refusé';
  } else if (S.gps && S.gps.accuracy <= 300) {
    chip.classList.add('ok'); label.textContent = 'GPS';
  } else if (S.gps) {
    chip.classList.add('approx'); label.textContent = 'GPS ±' + (S.gps.accuracy >= 1000 ? (S.gps.accuracy / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(S.gps.accuracy) + ' m');
  } else if (S.gpsError === 'unavailable') {
    chip.classList.add('bad'); label.textContent = 'GPS introuvable';
  } else {
    label.textContent = 'GPS…';
  }
  chip.title = S.gps ? `Précision ${Math.round(S.gps.accuracy)} m` : 'Recherche de la position';
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
  $('#places-label').textContent = mode === 'loop' ? 'Départ et retour' : 'Itinéraire';
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
  const clear = row.querySelector('.clear');
  let timer = null, ctrl = null, items = [];
  const close = () => { box.hidden = true; };
  const render = (typed = false) => {
    const list = [];
    if (which === 'start') list.push({ gps: true, label: 'Ma position actuelle', sub: S.gps ? 'GPS, précision ' + Math.round(S.gps.accuracy) + ' m' : 'en attente du GPS' });
    if (!typed) list.push(...recentPlaces().map((r) => ({ ...r, sub: 'Récent' + (r.sub ? ' · ' + r.sub : '') })));
    list.push(...items);
    box.innerHTML = list.map((it, i) => `<button type="button" data-i="${i}"><b>${escapeHtml(it.label)}</b>${it.sub ? `<span>${escapeHtml(it.sub)}</span>` : ''}</button>`).join('');
    box.hidden = list.length === 0;
    box.querySelectorAll('button').forEach((b) => b.addEventListener('mousedown', (ev) => ev.preventDefault()));
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const it = list[+b.dataset.i];
      if (!it.gps && !it.point) return;
      if (which === 'start') {
        S.start = it.gps ? { gps: true, label: 'Ma position actuelle', point: null } : { gps: false, label: it.label, point: it.point };
        input.value = S.start.label;
        updateGpsChip();
      } else {
        S.end = { label: it.label, point: it.point };
        input.value = it.label;
      }
      if (!it.gps) rememberPlace({ label: it.label, sub: (it.sub || '').replace(/^Récent( · )?/, ''), point: it.point });
      if (clear) clear.hidden = (which === 'start' && S.start.gps) || !input.value;
      close();
      input.blur();
      refreshFast();
    }));
  };
  input.addEventListener('focus', () => {
    // Avec « Ma position actuelle », on vide le champ pour pouvoir taper directement une adresse.
    if (which === 'start' && S.start.gps) input.value = '';
    else input.select();
    items = []; render();
  });
  input.addEventListener('blur', () => setTimeout(() => {
    close();
    if (which === 'start' && !input.value.trim()) input.value = S.start.label;
  }, 150));
  clear?.addEventListener('click', () => {
    if (which === 'start') { S.start = { gps: true, label: 'Ma position actuelle', point: null }; input.value = S.start.label; updateGpsChip(); }
    else { S.end = null; input.value = ''; S.fast = null; renderHome(); }
    clear.hidden = true;
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { items = []; render(q.length > 0); return; }
    timer = setTimeout(async () => {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        items = await searchPlaces(q, startPoint() || S.gps?.pos, { signal: ctrl.signal });
        if (!items.length) items = [{ label: 'Aucun résultat', sub: 'essaie avec le nom de la ville', point: null }];
        render(true);
      } catch (e) {
        if (e.name !== 'AbortError') { items = [{ label: 'Recherche d\'adresse indisponible', sub: 'vérifie le réseau', point: null }]; render(true); }
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

const CURRENT = { session: null };

async function startSearch() {
  const s = S.settings;
  let start = startPoint();
  if (!start && S.start.gps) {
    if (S.gpsError === 'denied') { toast(GPS_HELP, 9000); return; }
    toast('Recherche de ta position…', 12000);
    start = await waitForGps(12000);
    $('#toast').hidden = true;
  }
  if (!start) {
    toast('Position introuvable : choisis un point de départ dans la liste (tape une ville ou une adresse)', 7000);
    return;
  }
  if (s.mode === 'ab' && !S.end) { toast('Choisis une arrivée'); $('#end-input').focus(); return; }
  if (s.mode === 'ab' && haversine(start, S.end.point) < 1000) { toast('Départ et arrivée sont au même endroit : choisis plutôt « Boucle »', 5000); return; }
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
  CURRENT.session?.cancel();
  S.plan = { params: p };
  $('#list-sub').textContent = (p.mode === 'loop'
    ? `Boucle · ${fmtDuration(p.durationMin)} de roulage`
    : `Vers ${S.end.label}`) + ` · découverte ${s.discovery} % · ${p.fuelKm} km d'autonomie`;
  $('#route-list').innerHTML = '<div class="empty-card" id="list-placeholder">Les premiers parcours arrivent…</div>';
  $('#list-msg').hidden = true;
  $('#list-error-actions').hidden = true;
  $('#list-more').hidden = true;
  setProgress(true, 'Préparation…', 0.03, '');
  S.history = ['screen-home', 'screen-list'];
  show('screen-list', { push: false });

  let exclusions = [];
  try { exclusions = await exclusionSets(); } catch { /* mémoire indisponible */ }
  const session = new PlanSession(p, searchHooks(), { exclusions, prefs: loadPrefs() });
  CURRENT.session = session;
  S.plan.session = session;
  session.budget = 24;
  try {
    await session.start();
  } catch (e) {
    if (!(e instanceof AbortedError) && CURRENT.session === session) showSearchError(e);
  }
}

function setProgress(on, text, frac, meta) {
  const box = $('#list-progress');
  box.hidden = !on;
  if (!on) return;
  if (text != null) {
    const t = $('#ticker');
    if (t.textContent !== text) {
      t.textContent = text;
      t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    }
  }
  if (frac != null) $('#list-bar').style.width = Math.max(3, Math.min(100, frac * 100)) + '%';
  if (meta != null) $('#list-meta').textContent = meta;
}

function searchHooks() {
  const mine = () => CURRENT.session && CURRENT.session.hooks === hooks;
  const hooks = {
    onStep: (t) => { if (mine()) setProgress(true, t, null, null); },
    onRoute: (o) => {
      if (!mine()) return;
      $('#list-placeholder')?.remove();
      $('#route-list').insertAdjacentHTML('beforeend', cardHtml(o));
      bindCard(o);
    },
    onUpdate: (o) => { if (mine()) refreshCard(o); },
    onProgress: ({ computed, budget, shown }) => {
      if (!mine()) return;
      setProgress(true, null, computed / budget, `${shown} parcours trouvé${shown > 1 ? 's' : ''} · ${computed} calculé${computed > 1 ? 's' : ''} sur ${budget}`);
    },
    onDone: (info) => { if (mine()) searchDone(info); },
    onError: (e) => { if (mine()) showSearchError(e); },
  };
  return hooks;
}

function showSearchError(e) {
  setProgress(false);
  $('#list-placeholder')?.remove();
  const msg = $('#list-msg');
  msg.textContent = e.message || 'Erreur inattendue';
  msg.hidden = false;
  $('#list-error-actions').hidden = false;
  $('#list-more').hidden = !(CURRENT.session && CURRENT.session.options.length);
}

function searchDone(info) {
  const session = CURRENT.session;
  setProgress(false);
  $('#list-placeholder')?.remove();
  // Mise à jour des badges et du « meilleur choix ».
  for (const o of session.shown) refreshCard(o);
  const st = info.stats;
  const msg = $('#list-msg');
  msg.hidden = true;
  if (info.added === 0) {
    const alreadyDone = st.rejectedRide + st.rejectedDown;
    msg.hidden = false;
    if (session.options.length === 0 && alreadyDone > 0) {
      msg.textContent = `Tu as déjà roulé (ou écarté) tous les parcours trouvés avec ces réglages : ${alreadyDone} écarté${alreadyDone > 1 ? 's' : ''}. Augmente un peu la durée ou le degré de découverte pour en découvrir de nouveaux. Tes trajets déjà faits sont dans « Mes sorties ».`;
    } else if (session.options.length === 0) {
      msg.textContent = 'Aucun parcours trouvé avec ces réglages. Essaie une autre durée ou un autre point de départ.';
    } else if (alreadyDone > 0) {
      msg.textContent = `Plus de nouveaux parcours ici : ${alreadyDone} déjà faits ou écartés. Augmente un peu la durée pour aller plus loin.`;
    } else {
      msg.textContent = 'Plus de nouveaux parcours différents avec ces réglages.';
    }
  }
  $('#list-more').hidden = session.options.length === 0 || (info.added === 0 && !session.reference) || (session.reference && session.d === 0);
  $('#list-more').disabled = false;
  $('#list-more').textContent = 'Charger d\'autres parcours';
}

async function loadMore() {
  const session = CURRENT.session;
  if (!session || session.running) return;
  $('#list-more').hidden = true;
  $('#list-msg').hidden = true;
  setProgress(true, 'Recherche d\'autres parcours…', 0.03, '');
  await session.more();
}

function dotsHtml(n) {
  return `<span class="dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}

function cardBody(o) {
  const m = o.metrics;
  const pauses = o.stops.length;
  const fuel = o.stops.filter((s) => s.kind === 'fuel').length;
  const pauseInfo = o.stopsReady
    ? `<span class="indic" role="img" aria-label="${pauses} pauses dont ${fuel} plein"><svg aria-hidden="true"><use href="#i-cup"/></svg>${pauses}${fuel ? ' · ' + fuel + ' plein' : ''}</span>`
    : '<span class="pending-line">pauses en cours…</span>';
  return `${thumbSvg(o.route.shape, o.start)}
      <span class="body">
        ${o.best ? '<span class="best-flag">Notre préféré</span>' : ''}
        ${o.badge ? `<span class="badge ${o.badge.tone}">${escapeHtml(o.badge.label)}</span>` : ''}
        <span class="route-name">${escapeHtml(o.name)}</span>
        <span class="route-dur">${fmtDuration(o.route.timeS / 60)} · ${Math.round(o.route.totalM / 1000)} km</span>
        <span class="indics">
          <span class="indic" role="img" aria-label="Virages : ${m.curvRating} sur 5"><svg aria-hidden="true" style="color:var(--accent)"><use href="#i-logo"/></svg>${dotsHtml(m.curvRating)}</span>
          <span class="indic" role="img" aria-label="${m.panoramaCount} panoramas"><svg aria-hidden="true" style="color:var(--teal)"><use href="#i-mountain"/></svg>${m.panoramaCount}</span>
          ${pauseInfo}
        </span>
        ${o.fuelWarning ? `<span class="warn-line">${escapeHtml(o.fuelWarning.message)}</span>` : ''}
      </span>`;
}

function cardHtml(o) {
  return `<article class="route-card ${o.best ? 'best' : ''}" id="card-${o.id}">
    <button type="button" class="card-main" aria-label="Voir ${escapeHtml(o.name)}">${cardBody(o)}</button>
    <div class="votes">
      <button type="button" class="vote up" aria-pressed="${!!o.liked}" aria-label="J'aime ce parcours"><svg aria-hidden="true"><use href="#i-up"/></svg></button>
      <button type="button" class="vote down" aria-label="Pas pour moi : retirer ce parcours"><svg aria-hidden="true"><use href="#i-down"/></svg></button>
    </div>
  </article>`;
}

function bindCard(o) {
  const el = document.getElementById('card-' + o.id);
  if (!el) return;
  el.querySelector('.card-main').addEventListener('click', () => openDetail(o));
  el.querySelector('.vote.up').addEventListener('click', () => toggleLike(o));
  el.querySelector('.vote.down').addEventListener('click', () => dislike(o));
}

function refreshCard(o) {
  const el = document.getElementById('card-' + o.id);
  if (!el) return;
  if (o.removed) { el.remove(); return; }
  el.classList.toggle('best', !!o.best);
  el.querySelector('.card-main').innerHTML = cardBody(o);
  el.querySelector('.vote.up').setAttribute('aria-pressed', String(!!o.liked));
}

// --- Votes ---------------------------------------------------------------------

function refFeatures() {
  const opts = CURRENT.session ? CURRENT.session.options : [];
  if (opts.length < 2) return null;
  const ref = {};
  for (const { key } of TASTES) ref[key] = opts.reduce((a, o) => a + (o.features?.[key] ?? 0.5), 0) / opts.length;
  return ref;
}

async function toggleLike(o) {
  o.features = o.features || featureVector(o.metrics);
  if (!o.liked) {
    o.liked = true;
    learn(o.features, 1, refFeatures());
    recordVote({ t: Date.now(), vote: 'up', name: o.name, km: Math.round(o.route.totalM / 1000), min: Math.round(o.route.timeS / 60), id: o.id });
    try { await saveLiked(o.id, o); } catch { /* mémoire indisponible */ }
    toast('Ajouté à tes parcours aimés (dans « Mes sorties »)', 2500);
  } else {
    o.liked = false;
    learn(o.features, -1, refFeatures());
    try { await deleteLiked(o.id); } catch { /* ignoré */ }
    toast('Retiré de tes parcours aimés', 2000);
  }
  refreshCard(o);
  if (S.option === o) $('#detail-like').setAttribute('aria-pressed', String(!!o.liked));
}

function dislike(o) {
  o.features = o.features || featureVector(o.metrics);
  const ref = refFeatures();
  const el = document.getElementById('card-' + o.id);
  learn(o.features, -1, ref);
  const vote = { t: Date.now(), vote: 'down', name: o.name, km: Math.round(o.route.totalM / 1000), min: Math.round(o.route.timeS / 60), id: o.id, cells: [...(o.cells || [])] };
  recordVote(vote);
  if (o.liked) { o.liked = false; deleteLiked(o.id).catch(() => {}); }
  CURRENT.session?.remove(o);
  const finish = () => { el?.remove(); for (const x of CURRENT.session?.options || []) refreshCard(x); };
  if (el) { el.classList.add('leaving'); setTimeout(finish, 260); } else finish();
  toast(`« ${o.name} » retiré`, 6000, {
    label: 'Annuler',
    fn: () => {
      learn(o.features, 1, ref);
      const votes = loadVotes().filter((v) => !(v.id === o.id && v.vote === 'down'));
      try { localStorage.setItem('viree.votes.v1', JSON.stringify(votes)); } catch { /* ignoré */ }
      CURRENT.session?.restore(o);
      if (!document.getElementById('card-' + o.id)) {
        $('#route-list').insertAdjacentHTML('beforeend', cardHtml(o));
        bindCard(o);
      }
      for (const x of CURRENT.session?.options || []) refreshCard(x);
    },
  });
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
  $('#detail-like').setAttribute('aria-pressed', String(!!o.liked));
  $('#detail-votes').hidden = !!o.fromHistory;

  // Programme : départ, pauses, points de vue en passant, arrivée.
  const items = [{ t: 0, html: `<span class="tl-ico"><svg aria-hidden="true" style="color:#fff"><use href="#i-flag"/></svg></span><span class="tl-txt"><b>Départ</b><span>${escapeHtml(o.startLabel || S.start.label)}</span></span>`, along: 0 }];
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

async function openDetail(option, { fromHistory = false } = {}) {
  S.option = option;
  option.fromHistory = fromHistory;
  if (!option.startLabel) option.startLabel = S.start.gps ? 'Ma position actuelle' : S.start.label;
  show('screen-detail');
  const go = $('#detail-go');
  const upd = $('#detail-updating');
  const busy = (on, text) => {
    upd.hidden = !on; if (text) upd.textContent = text;
    go.disabled = on; $('#detail-sim').disabled = on;
  };
  // Pauses pas encore calculées (parcours ouvert pendant la recherche).
  if (!option.stopsReady && !fromHistory && CURRENT.session) {
    renderDetail();
    busy(true, 'Recherche des pauses et du plein…');
    try { await CURRENT.session.ensureStops(option); } catch { /* sans pauses */ }
    option.stopsReady = true;
    refreshCard(option);
  }
  renderDetail();
  // Recalcul en passant par les pauses, pour que le guidage y mène.
  if (option.stops.length && !option.withStops) {
    busy(true, 'Mise à jour du guidage vers les pauses…');
    try {
      const r = await routeWithStops(option, S.settings);
      option.route = r;
      const pois = CURRENT.session?.pois || [];
      option.metrics = { ...option.metrics, ...analyzeRoute(r, pois, option.mode), curvRating: option.metrics.curvRating };
      option.withStops = true;
      if (S.option === option) renderDetail();
    } catch (e) {
      toast('Guidage vers les pauses indisponible, elles seront signalées en chemin');
    }
  }
  busy(false);
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
  o.fuelKm = S.plan?.params?.fuelKm ?? S.settings.fuelKm;
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
  engine.simulated = simulate;
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
  // Enregistrement dans « Mes sorties » (sauf essai trop court).
  S.lastRide = null;
  renderStars($('#end-stars'), 0);
  $('#end-rate-msg').textContent = 'Ta note aide l\'appli à mieux choisir tes prochaines virées.';
  if (sum.odometerM >= 300 && sum.track.length > 1) {
    const rec = rideRecord(sum, o);
    rec.simulated = !!sum.simulated;
    S.lastRide = rec;
    saveRide(rec).catch(() => toast('Sortie non enregistrée (mémoire du téléphone indisponible)'));
  } else {
    $('#end-rate-msg').textContent = 'Sortie trop courte pour être enregistrée dans « Mes sorties ».';
  }
}

// --- Note sur 5 étoiles ------------------------------------------------------------

function renderStars(box, n) {
  box.querySelectorAll('button').forEach((b) => {
    const r = +b.dataset.r;
    b.querySelector('use').setAttribute('href', r <= n ? '#i-star' : '#i-star-o');
    b.setAttribute('aria-pressed', String(r === n));
  });
}

async function rateLastRide(n) {
  const rec = S.lastRide;
  renderStars($('#end-stars'), n);
  if (!rec) return;
  const first = rec.rating == null;
  const prev = rec.rating;
  rec.rating = n;
  try { await rateRide(rec.id, n); } catch { /* ignoré */ }
  const f = S.summary?.option?.features || (S.summary?.option?.metrics?.degPerKm != null ? featureVector(S.summary.option.metrics) : null);
  if (f) {
    // Une note compte plus qu'un pouce ; si on change d'avis, on corrige l'apprentissage.
    if (!first) learn(f, -((prev - 3) / 2) * 1.5, null);
    learn(f, ((n - 3) / 2) * 1.5, null);
  }
  $('#end-rate-msg').textContent = n >= 4 ? 'Merci ! On te proposera plus de virées dans ce genre.' : n <= 2 ? 'Merci, noté : on évitera ce genre de parcours.' : 'Merci pour ta note !';
}

// --- Mes sorties ----------------------------------------------------------------------

const RATING_COLORS = { 5: '#0B6E6E', 4: '#3A9E8F', 3: '#B88A00', 2: '#E8590C', 1: '#B42318', 0: '#7A8087' };
const ratingColor = (r) => RATING_COLORS[r || 0];

function starsText(n) {
  return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : 'pas encore notée';
}

async function openRides() {
  S.history.push('screen-rides');
  show('screen-rides', { push: false });
  await renderRides();
}

async function renderRides(focusId = null) {
  const rides = await listRides();
  const liked = await listLiked();
  const votes = loadVotes();
  const real = rides.filter((r) => !r.simulated);
  const km = real.reduce((a, r) => a + (r.km || 0), 0);
  const hours = real.reduce((a, r) => a + (r.movingS || 0), 0) / 3600;
  const rated = real.filter((r) => r.rating);
  const avg = rated.length ? rated.reduce((a, r) => a + r.rating, 0) / rated.length : 0;
  $('#rides-stats').innerHTML = [
    [String(real.length), real.length > 1 ? 'sorties' : 'sortie'],
    [Math.round(km).toLocaleString('fr-FR') + ' km', 'au total'],
    [hours >= 1 ? Math.floor(hours) + ' h ' + String(Math.round((hours % 1) * 60)).padStart(2, '0') : Math.round(hours * 60) + ' min', 'de roulage'],
  ].map(([v, l]) => `<div><dt>${l}</dt><dd>${v}</dd></div>`).join('');
  $('#rides-empty').hidden = rides.length > 0;
  $('#rides-legend').innerHTML = [5, 4, 3, 2, 1, 0].map((r) => `<span><i style="background:${ratingColor(r)}"></i>${r ? r + '★' : 'non notée'}</span>`).join('') + (avg ? `<span style="margin-left:auto">note moyenne ${avg.toFixed(1).replace('.', ',')} ★</span>` : '');

  // Carte de toutes les sorties.
  if (!S.maps.rides) S.maps.rides = createMap('rides-map');
  const map = S.maps.rides;
  if (S.ridesLayer) S.ridesLayer.remove();
  const g = L.layerGroup().addTo(map);
  const all = [];
  const lines = {};
  for (const r of rides.slice().reverse()) {
    const tr = rideTrack(r);
    if (tr.length < 2) continue;
    all.push(...tr);
    const focus = r.id === focusId;
    if (focus) L.polyline(tr, { color: '#FFFFFF', weight: 9, opacity: 0.9 }).addTo(g);
    lines[r.id] = L.polyline(tr, { color: ratingColor(r.rating), weight: focus ? 6 : 4, opacity: r.simulated ? 0.5 : 0.9, dashArray: r.simulated ? '6 6' : null }).addTo(g);
    lines[r.id].on('click', () => renderRides(r.id));
  }
  S.ridesLayer = g;
  setTimeout(() => {
    map.invalidateSize();
    const fit = focusId && lines[focusId] ? lines[focusId].getBounds() : (all.length ? L.latLngBounds(all) : null);
    if (fit) map.fitBounds(fit, { padding: [20, 20] });
    else map.setView(startPoint() || S.gps?.pos || [45.07, 7.4], 9);
  }, 60);

  // Liste des sorties.
  $('#rides-section').hidden = rides.length === 0;
  $('#rides-list').innerHTML = rides.map((r) => {
    const d = new Date(r.date);
    return `<li class="item ${r.id === focusId ? 'focus' : ''}" data-id="${r.id}">
      <div class="item-head"><span class="item-swatch" style="background:${ratingColor(r.rating)}"></span>
        <div style="flex:1;min-width:0"><div class="item-name">${escapeHtml(r.name)}${r.simulated ? ' <span class="badge">simulation</span>' : ''}</div>
        <div class="item-sub">${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })} · ${String(r.km).replace('.', ',')} km · ${fmtDuration(r.movingS / 60)}</div></div></div>
      <div class="stars small" role="group" aria-label="Note de ${escapeHtml(r.name)}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-r="${n}" aria-label="${n} étoile${n > 1 ? 's' : ''}"><svg aria-hidden="true"><use href="#${n <= (r.rating || 0) ? 'i-star' : 'i-star-o'}"/></svg></button>`).join('')}</div>
      <div class="item-actions">
        <button type="button" data-act="show">Voir sur la carte</button>
        <button type="button" data-act="redo"><svg aria-hidden="true"><use href="#i-play"/></svg>Refaire</button>
        <button type="button" data-act="gpx"><svg aria-hidden="true"><use href="#i-download"/></svg>GPX</button>
        <button type="button" data-act="del" class="danger" aria-label="Supprimer cette sortie"><svg aria-hidden="true"><use href="#i-trash"/></svg></button>
      </div></li>`;
  }).join('');
  $$('#rides-list .item').forEach((li) => {
    const r = rides.find((x) => x.id === li.dataset.id);
    li.querySelectorAll('.stars button').forEach((b) => b.addEventListener('click', async () => {
      const n = +b.dataset.r;
      const prev = r.rating;
      await rateRide(r.id, n);
      const f = r.option?.metrics ? featureVector(r.option.metrics) : null;
      if (f) { if (prev) learn(f, -((prev - 3) / 2) * 1.5, null); learn(f, ((n - 3) / 2) * 1.5, null); }
      renderRides(r.id);
    }));
    li.querySelector('[data-act="show"]').addEventListener('click', () => { renderRides(r.id); $('#screen-rides .scroll').scrollTo({ top: 0, behavior: 'smooth' }); });
    li.querySelector('[data-act="redo"]').addEventListener('click', () => {
      if (!r.option) { toast('Parcours non disponible'); return; }
      const opt = unpackOption(r.option);
      opt.id = 'h' + r.id;
      openDetail(opt, { fromHistory: true });
    });
    li.querySelector('[data-act="gpx"]').addEventListener('click', () => downloadText(slug(r.name) + '-trace.gpx', trackGpx(r.name, rideTrack(r).map((p) => [p[0], p[1], r.date]))));
    const del = li.querySelector('[data-act="del"]');
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.innerHTML = 'Confirmer la suppression'; return; }
      await deleteRide(r.id);
      renderRides();
    });
  });

  // Parcours aimés.
  $('#liked-section').hidden = liked.length === 0;
  $('#liked-list').innerHTML = liked.map((l) => {
    const o = l.option;
    return `<li class="item" data-id="${l.id}"><div class="item-name">${escapeHtml(o.name)}</div>
      <div class="item-sub">${o.mode === 'loop' ? 'Boucle' : 'Trajet'} · ${fmtDuration(o.route.timeS / 60)} · ${Math.round(o.route.lengthKm)} km · aimé le ${new Date(l.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</div>
      <div class="item-actions"><button type="button" data-act="open"><svg aria-hidden="true"><use href="#i-play"/></svg>Ouvrir</button><button type="button" data-act="del" class="danger">Retirer</button></div></li>`;
  }).join('');
  $$('#liked-list .item').forEach((li) => {
    const l = liked.find((x) => x.id === li.dataset.id);
    li.querySelector('[data-act="open"]').addEventListener('click', () => {
      const opt = unpackOption(l.option);
      opt.id = l.id; opt.liked = true;
      openDetail(opt, { fromHistory: true });
    });
    li.querySelector('[data-act="del"]').addEventListener('click', async () => { await deleteLiked(l.id); renderRides(); });
  });

  // Historique des votes.
  $('#votes-section').hidden = votes.length === 0;
  $('#votes-list').innerHTML = votes.slice(0, 40).map((v) => `<li class="item"><svg aria-hidden="true" style="color:${v.vote === 'up' ? 'var(--teal)' : 'var(--accent)'}"><use href="#i-${v.vote === 'up' ? 'up' : 'down'}"/></svg><span style="flex:1;min-width:0">${escapeHtml(v.name)}</span><span class="item-sub">${v.km} km · ${new Date(v.t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span></li>`).join('');
}

// --- Goûts appris (réglages) ---------------------------------------------------------

function renderTastes() {
  const p = loadPrefs();
  $('#tastes').innerHTML = TASTES.map(({ key, label }) => {
    const v = p[key] || 0;
    const w = Math.abs(v) * 50;
    const left = v >= 0 ? 50 : 50 - w;
    const txt = Math.abs(v) < 0.08 ? 'neutre' : v > 0.5 ? 'adore' : v > 0 ? 'aime' : v < -0.5 ? 'évite' : 'bof';
    return `<div class="taste"><span>${label}</span><span class="taste-bar" role="img" aria-label="${label} : ${txt}"><i style="left:${left}%;width:${w}%;background:${v >= 0 ? 'var(--teal)' : 'var(--accent)'}"></i></span><span>${txt}</span></div>`;
  }).join('') + `<p class="hint" style="padding:8px 14px 12px;margin:0">${p.n ? `Appris de ${p.n} vote${p.n > 1 ? 's' : ''} et notes.` : 'Vote pour des parcours (pouce haut ou bas) et note tes sorties : l\'appli apprendra ce que tu aimes.'}</p>`;
}

// --- Adresses récentes -------------------------------------------------------------------

const RECENT_KEY = 'viree.recent.v1';
function recentPlaces() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function rememberPlace(it) {
  if (!it || !it.point) return;
  const list = recentPlaces().filter((x) => x.label !== it.label);
  list.unshift({ label: it.label, sub: it.sub || '', point: it.point });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 6))); } catch { /* ignoré */ }
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
  $('#open-settings').addEventListener('click', () => { renderSettings(); renderTastes(); show('screen-settings'); });
  $$('[data-back]').forEach((b) => b.addEventListener('click', () => { back(); renderHome(); }));

  $('#list-back').addEventListener('click', () => { CURRENT.session?.cancel(); S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#list-again').addEventListener('click', () => { CURRENT.session?.cancel(); S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#list-edit').addEventListener('click', () => { S.history = ['screen-home']; show('screen-home', { push: false }); });
  $('#list-retry').addEventListener('click', () => startSearch());
  $('#list-stop').addEventListener('click', () => { CURRENT.session?.stop(); $('#ticker').textContent = 'Arrêt après le parcours en cours…'; });
  $('#list-more').addEventListener('click', loadMore);
  $('#detail-back').addEventListener('click', () => {
    if (S.option?.fromHistory) { back(); return; }
    S.history = ['screen-home', 'screen-list']; show('screen-list', { push: false });
  });
  $('#detail-others').addEventListener('click', () => {
    if (S.option?.fromHistory) { back(); return; }
    S.history = ['screen-home', 'screen-list']; show('screen-list', { push: false });
  });
  $('#detail-like').addEventListener('click', () => S.option && toggleLike(S.option));
  $('#detail-dislike').addEventListener('click', () => {
    const o = S.option;
    if (!o) return;
    S.history = ['screen-home', 'screen-list']; show('screen-list', { push: false });
    dislike(o);
  });
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
  $('#end-rides').addEventListener('click', () => { S.history = ['screen-home']; openRides(); });
  $$('#end-stars button').forEach((b) => b.addEventListener('click', () => rateLastRide(+b.dataset.r)));
  $('#open-rides').addEventListener('click', openRides);
  $('#rides-back').addEventListener('click', back);
  $('#reset-tastes').addEventListener('click', () => { resetPrefs(); renderTastes(); toast('Goûts remis à zéro', 2000); });
  $('#clear-votes').addEventListener('click', () => { clearVotes(); toast('Votes effacés : les parcours refusés pourront être reproposés', 3500); });

  $('#gps-chip').addEventListener('click', () => {
    if (S.gpsError === 'denied' || S.gpsError === 'unsupported') toast(GPS_HELP, 9000);
    else if (S.gps) toast(`Position trouvée, précision ${Math.round(S.gps.accuracy)} m`, 2500);
    else toast('Recherche de la position… (à l\'intérieur, le GPS peut mettre une minute)', 4000);
    if (!MOCK) restartGps();
  });
  startGps();
  if (!MOCK && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__viree = S; // pratique pour le débogage
}

init();
