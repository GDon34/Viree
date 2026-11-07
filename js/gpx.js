// Export GPX (parcours prévu ou trace enregistrée).
import { escapeHtml } from './format.js';

function header(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Virée GPS moto" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${escapeHtml(name)}</name><time>${new Date().toISOString()}</time></metadata>
`;
}

export function routeGpx(option) {
  let s = header(option.name);
  for (const st of option.stops || []) {
    s += `<wpt lat="${st.point[0].toFixed(6)}" lon="${st.point[1].toFixed(6)}"><name>${escapeHtml(st.label + ' — ' + st.name)}</name><type>${st.kind === 'fuel' ? 'Fuel' : 'Pause'}</type></wpt>\n`;
  }
  s += `<trk><name>${escapeHtml(option.name)}</name><trkseg>\n`;
  for (const [la, lo] of option.route.shape) s += `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"/>\n`;
  s += '</trkseg></trk>\n</gpx>\n';
  return s;
}

export function trackGpx(name, track) {
  let s = header(name);
  s += `<trk><name>${escapeHtml(name)}</name><trkseg>\n`;
  for (const [la, lo, t] of track) s += `<trkpt lat="${la.toFixed(6)}" lon="${lo.toFixed(6)}"><time>${new Date(t).toISOString()}</time></trkpt>\n`;
  s += '</trkseg></trk>\n</gpx>\n';
  return s;
}

export function slug(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'viree';
}

export async function downloadText(filename, text, mime = 'application/gpx+xml') {
  const blob = new Blob([text], { type: mime });
  // Sur Android, le partage permet d'envoyer directement le fichier vers une autre appli.
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
