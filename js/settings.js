// Réglages et dernières saisies, gardés dans le navigateur du téléphone.
const KEY = 'viree.settings.v1';

export const DEFAULTS = {
  fullTankKm: 280,
  safetyKm: 30,
  pauseEveryMin: 60,
  pauseDurationMin: 20,
  pauseTypes: { cafe: true, restaurant: true, viewpoint: true, picnic: false },
  avoid: { highways: true, tolls: true, ferries: false, unpaved: true },
  voice: true,
  theme: 'auto',
  smallRoads: true,
  // Dernières saisies
  mode: 'loop',
  durationMin: 180,
  wishMin: 120,
  maxMin: 240,
  discovery: 60,
  fuelKm: 140,
};

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  return {
    ...DEFAULTS,
    ...saved,
    pauseTypes: { ...DEFAULTS.pauseTypes, ...(saved.pauseTypes || {}) },
    avoid: { ...DEFAULTS.avoid, ...(saved.avoid || {}) },
  };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* stockage indisponible */ }
}
