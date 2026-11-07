// Mise en forme (français).

export function fmtDuration(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return m + ' min';
  return h + ' h ' + String(m).padStart(2, '0');
}

export function fmtClockDelta(sec) {
  const m = Math.round(sec / 60);
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}

export function fmtClock(date) {
  return date.getHours() + ' h ' + String(date.getMinutes()).padStart(2, '0');
}

export function fmtKm(m) {
  const km = m / 1000;
  return (km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)) + ' km';
}

// Distance affichée avant une manœuvre.
export function fmtDist(m) {
  if (m < 1000) {
    const r = m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
    return r + ' m';
  }
  return (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
}

// Distance prononcée : « 300 mètres », « 1,5 kilomètre ».
export function spokenDist(m) {
  if (m < 1000) {
    const r = m < 200 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50;
    return r + ' mètres';
  }
  const km = Math.round(m / 100) / 10;
  const txt = String(km).replace('.', ',');
  return txt + (km < 2 ? ' kilomètre' : ' kilomètres');
}

export function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lever / coucher du soleil approximatifs (algorithme NOAA simplifié), en heures locales décimales.
export function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const day = Math.floor((date - start) / 86400000);
  const g = (2 * Math.PI / 365) * (day - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl))) - Math.tan(lat * rad) * Math.tan(decl);
  if (cosH > 1) return { rise: 12, set: 12 };
  if (cosH < -1) return { rise: 0, set: 24 };
  const ha = Math.acos(cosH) / rad;
  const tz = -date.getTimezoneOffset();
  const rise = (720 - 4 * (lon + ha) - eqt + tz) / 60;
  const set = (720 - 4 * (lon - ha) - eqt + tz) / 60;
  return { rise, set };
}

export function isNight(date, lat, lon) {
  const { rise, set } = sunTimes(date, lat, lon);
  const h = date.getHours() + date.getMinutes() / 60;
  return h < rise || h > set;
}
