// Noms de parcours inventés, inspirés de ce que le parcours traverse.

const NUMBERS = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept'];

const TWISTY = ['La boucle des lacets', 'La valse des virages', 'Le ruban sinueux', 'Les mille virages', 'La route qui danse', 'Le serpentin'];
const CALM = ['La promenade des pâquerettes', 'La balade des coquelicots', 'La flânerie du dimanche', 'Le chemin des écoliers', 'La route buissonnière', 'La balade des tournesols'];
const WHIMSY = ['La boucle des lamas', 'La virée des marmottes', 'La ronde des vaches', 'La tournée des chamois', 'L\'échappée des papillons', 'La boucle des hérissons', 'La virée des grillons', 'La tournée des écureuils'];
const VIEWS = ['La route des belvédères', 'Le balcon panoramique', 'La tournée des points de vue', 'La virée des grands espaces'];
const AB_TWISTY = ['Le détour des lacets', 'La traversée sinueuse', 'Le grand détour'];
const AB_CALM = ['La route buissonnière', 'Le chemin des écoliers', 'La traversée des pâquerettes'];
const AB_FAST = ['La route directe', 'Le chemin le plus court', 'La ligne droite (ou presque)'];
const OFF_EASY = ['La piste des écureuils', 'La boucle des cailloux', 'Le chemin des bergers', 'La virée poussiéreuse', 'La piste aux étoiles', 'La balade des ornières'];
const OFF_HARD = ['Le chemin des contrebandiers', 'La piste des chamois', 'La traversée des crêtes', 'La grimpette des sangliers', 'Les cailloux qui roulent', 'La piste des aventuriers'];
const OFF_TET = ['L\'échappée TET', 'Le tronçon des voyageurs', 'La boucle transeuropéenne', 'Le raccourci du TET'];

// « du Colle del Lys », « de Sestrières », « du Lago di Avigliana », « de la Bonette »…
export function withDe(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  const masc = ['col ', 'colle ', 'passo ', 'pas ', 'pass ', 'port ', 'lago ', 'lac ', 'château', 'castello ', 'mont ', 'monte ', 'pic ', 'pont ', 'fort ', 'forte ', 'belvédère', 'saut ', 'barrage'];
  const fem = ['cascade', 'cascata', 'route', 'tour ', 'torre ', 'abbaye', 'chapelle', 'roche', 'rocca '];
  if (/^(le |la |les |l'|il |lo |gli |i )/i.test(name)) {
    if (/^le /i.test(name)) return 'du ' + name.slice(3);
    if (/^les /i.test(name)) return 'des ' + name.slice(4);
    return 'de ' + name;
  }
  if (masc.some((m) => lower.startsWith(m))) return 'du ' + name;
  if (fem.some((m) => lower.startsWith(m))) return 'de la ' + name;
  if (/^[aeiouyhéèêàâîôû]/i.test(name)) return 'd\'' + name;
  return 'de ' + name;
}

function pick(list, rand, used) {
  const free = list.filter((n) => !used.has(n));
  const src = free.length ? free : list;
  return src[Math.floor(rand() * src.length)];
}

function nameCandidates(c, mode, rand, used) {
  const m = c.metrics;
  const pass = m.sights.filter((s) => s.kind === 'pass' && s.name).sort((a, b) => (b.ele || 0) - (a.ele || 0))[0];
  const lakes = m.lakes.filter((s) => s.name);
  const castle = m.sights.find((s) => s.kind === 'castle' && s.name);
  const views = m.sights.filter((s) => s.kind === 'viewpoint').length;
  const options = [];
  if (c.offroad && c.offroad.checked) {
    const o = c.offroad;
    if (o.tet && o.tetKm > 3) options.push(...OFF_TET);
    if (pass && o.maxGrade >= 3) options.push(`La piste ${withDe(pass.name)}`);
    options.push(...(o.maxGrade >= 4 ? OFF_HARD : OFF_EASY));
    return options;
  }
  if (c.isReference) options.push(...AB_FAST);
  if (pass && m.curvRating >= 3) {
    const de = withDe(pass.name);
    options.push(mode === 'ab' ? `Le détour ${de}` : `Les lacets ${de}`, `La montée ${de}`, `L'escapade ${de}`);
  }
  if (lakes.length >= 2) options.push(`Le tour des ${NUMBERS[Math.min(lakes.length, 7)]} lacs`);
  else if (lakes.length === 1) options.push(`La balade ${withDe(lakes[0].name)}`);
  if (castle) options.push(`La virée ${withDe(castle.name)}`);
  if (views >= 3) options.push(...VIEWS);
  if (!options.length || rand() < 0.25) {
    if (mode === 'ab') options.push(...(m.curvRating >= 4 ? AB_TWISTY : AB_CALM));
    else if (m.curvRating >= 4) options.push(...TWISTY);
    else if (m.curvRating <= 2) options.push(...CALM, ...WHIMSY);
    else options.push(...WHIMSY);
  }
  return options;
}

export function nameFor(c, mode, rand, used = new Set()) {
  let n = pick(nameCandidates(c, mode, rand, used), rand, used);
  if (used.has(n)) n = pick(mode === 'ab' ? AB_CALM.concat(WHIMSY) : WHIMSY.concat(CALM), rand, used);
  if (used.has(n)) { let k = 2; while (used.has(n + ' ' + k)) k++; n = n + ' ' + k; }
  return n;
}

// Un badge par parcours, chacun distinct.
export function assignBadges(list) {
  for (const c of list) c.badge = null;
  if (list.length < 2) return;
  const by = (f) => list.slice().sort((a, b) => f(b) - f(a));
  const assign = (c, label, tone) => { if (c && !c.badge) c.badge = { label, tone }; };
  if (list.some((c) => c.offroad && c.offroad.checked)) {
    const off = list.filter((c) => c.offroad && c.offroad.checked);
    const byO = (f) => off.slice().sort((a, b) => f(b) - f(a));
    assign(byO((c) => c.offroad.tetKm).find((c) => !c.badge && c.offroad.tetKm > 3), 'Sur le TET', 'scenic');
    assign(byO((c) => c.offroad.share).find((c) => !c.badge), 'Le plus de pistes', 'accent');
    assign(byO((c) => -c.offroad.longestSlowMin).find((c) => !c.badge), 'Le plus roulant', 'neutral');
    assign(byO((c) => -c.offroad.maxGrade).find((c) => !c.badge), 'Le plus facile', 'neutral');
    return;
  }
  const ref = list.find((c) => c.isReference);
  if (ref) assign(ref, 'Le plus rapide', 'neutral');
  assign(by((c) => c.metrics.degPerKm).find((c) => !c.badge && c.metrics.curvRating >= 3), 'Le plus sinueux', 'accent');
  assign(by((c) => c.metrics.panoramaScore).find((c) => !c.badge && c.metrics.panoramaScore > 0), 'Le plus panoramique', 'scenic');
  assign(list.find((c) => !c.badge && c.metrics.lakes.length >= 2), 'Au bord de l\'eau', 'scenic');
  assign(by((c) => -c.metrics.degPerKm - c.metrics.manDensity * 5).find((c) => !c.badge), 'Le plus tranquille', 'neutral');
}
