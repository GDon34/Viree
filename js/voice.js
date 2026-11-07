// Voix (synthèse vocale du téléphone, en français). Toute erreur est ignorée :
// la navigation doit continuer même si la voix ne marche pas.
let voice = null;
let enabled = true;
let lastText = '';
let lastAt = 0;

const supported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

function pickVoice() {
  try {
    const voices = speechSynthesis.getVoices();
    voice = voices.find((v) => v.lang === 'fr-FR' && /google/i.test(v.name))
      || voices.find((v) => v.lang === 'fr-FR')
      || voices.find((v) => v.lang && v.lang.startsWith('fr'))
      || null;
  } catch { voice = null; }
}

export function initVoice() {
  if (!supported()) return false;
  pickVoice();
  try { speechSynthesis.onvoiceschanged = pickVoice; } catch { /* ignoré */ }
  return true;
}

export function setVoiceEnabled(on) {
  enabled = on;
  if (!on && supported()) { try { speechSynthesis.cancel(); } catch { /* ignoré */ } }
}

// À appeler depuis un clic : Chrome n'autorise la voix qu'après un geste de l'utilisateur.
export function unlockVoice() {
  if (!supported()) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { /* ignoré */ }
}

export function speak(text, priority = 'normal') {
  if (!enabled || !text || !supported()) return;
  const now = Date.now();
  if (text === lastText && now - lastAt < 8000) return;
  lastText = text; lastAt = now;
  try {
    if (priority === 'high') speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    if (voice) u.voice = voice;
    u.rate = 1.02;
    speechSynthesis.speak(u);
  } catch { /* ignoré */ }
}
