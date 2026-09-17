/**
 * Banc d'essai de l'algorithme de comptage — `npm test`
 * ------------------------------------------------------
 * On extrait la classe `SpinCounter` de public/app.js et on lui injecte des
 * `worldLandmarks` synthétiques : une personne virtuelle qui tourne, oscille,
 * sort du cadre… Ça permet de retoucher les réglages de `CONFIG` en étant sûr
 * de ne casser ni le comptage, ni les protections anti-faux-positifs.
 *
 *   node --test           (ou)   npm test
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------- extraction de SpinCounter depuis app.js ---------------- */

const SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function extractClass(src, name) {
  const start = src.indexOf(`class ${name}`);
  if (start < 0) throw new Error(`classe ${name} introuvable dans app.js`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`accolade fermante manquante pour ${name}`);
}

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const LM = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24 };

const SpinCounter = new Function(
  'TAU', 'DEG', 'LM',
  `${extractClass(SRC, 'SpinCounter')}; return SpinCounter;`
)(TAU, DEG, LM);

// On rejoue la configuration réelle du front, lue directement dans app.js
// pour que le test suive automatiquement tout changement de réglage.
const CONFIG = Object.fromEntries(
  ['zGain', 'smoothing', 'minSegment', 'shoulderWeight', 'hipWeight',
   'maxStepDeg', 'directionLockDeg', 'reverseToleranceDeg', 'minTurnMs', 'lostTrackResetMs']
    .map((k) => {
      const m = SRC.match(new RegExp(`\\b${k}:\\s*([\\d.]+)`));
      if (!m) throw new Error(`réglage ${k} introuvable dans CONFIG`);
      return [k, Number(m[1])];
    })
);

/* ---------------- personne virtuelle ---------------- */

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
/** Bruit ~gaussien (somme de 4 uniformes), écart-type ≈ `s` mètres. */
const noiseOf = (s) => s * (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

/**
 * @param {number} phi  yaw réel (rad) — 0 = face caméra
 * @param {number} n    bruit de mesure (m)
 * @param {number} sq   écrasement de la profondeur par MediaPipe (0,25 → 1,3)
 */
function pose(phi, n = 0.01, sq = 0.7) {
  const p = (r, y) => ({
    x: r * Math.cos(phi) + noiseOf(n),
    y: y + noiseOf(n),
    z: -r * Math.sin(phi) * sq + noiseOf(n),
  });
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  lm[LM.L_SHOULDER] = p(0.19, -0.5);
  lm[LM.R_SHOULDER] = p(-0.19, -0.5);
  lm[LM.L_HIP] = p(0.13, 0);
  lm[LM.R_HIP] = p(-0.13, 0);
  return lm;
}

function play({ phiAt, seconds = 30, fps = 30, noise = 0.01, squash = 0.7, dropout = null, settleMs = 600 }) {
  const c = new SpinCounter(CONFIG);
  const end = seconds * 1000;
  // Le joueur s'immobilise en fin de manche : ça laisse le lissage converger,
  // comme dans la réalité. Sans ça on mesurerait le retard du filtre.
  for (let t = 0; t <= end + settleMs; t += 1000 / fps) {
    if (dropout && t >= dropout[0] && t <= dropout[1]) { c.miss(); continue; }
    c.update(pose(phiAt(Math.min(t, end) / 1000), noise, squash), t);
  }
  return c.spins;
}

/* ---------------- mini-runner ---------------- */

const results = [];
function check(label, got, expected) {
  const ok = Array.isArray(expected)
    ? got >= expected[0] && got <= expected[1]
    : got === expected;
  const exp = Array.isArray(expected) ? `${expected[0]}-${expected[1]}` : expected;
  results.push(ok);
  console.log(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} ${label.padEnd(54)} attendu ${String(exp).padStart(5)}   obtenu ${String(got).padStart(3)}`);
}
const section = (t) => console.log(`\n  \x1b[1m${t}\x1b[0m`);

/** Rotation régulière de `n` tours ; +0,05 tour pour ne pas finir pile sur le buzzer. */
const turns = (n, seconds = 30) => (t) => t * ((n + 0.05) / seconds) * TAU;
const oscillate = (ampDeg, hz) => (t) => ampDeg * DEG * Math.sin(t * hz * TAU);

console.log(`\n  \x1b[1mBANC D'ESSAI — comptage des tours\x1b[0m`);
console.log(`  réglages lus dans app.js : zGain=${CONFIG.zGain} smoothing=${CONFIG.smoothing} ` +
            `reverse=${CONFIG.reverseToleranceDeg}° lock=${CONFIG.directionLockDeg}°`);
console.log('  ' + '─'.repeat(84));

section('Comptage nominal');
check('5 tours en 30 s', play({ phiAt: turns(5) }), 5);
check('10 tours en 30 s', play({ phiAt: turns(10) }), 10);
check('20 tours en 30 s (0,67 tour/s)', play({ phiAt: turns(20) }), 20);
check('sens anti-horaire, 8 tours', play({ phiAt: (t) => -turns(8)(t) }), 8);
check('départ dos à la caméra', play({ phiAt: (t) => Math.PI + turns(6)(t) }), 6);
check('rotation saccadée (accélère / ralentit)',
  play({ phiAt: (t) => turns(5)(t) + 1.2 * Math.sin(t * 2) }), 5);

section('Robustesse caméra / modèle');
check('bruit fort (σ = 3 cm)', play({ phiAt: turns(5), noise: 0.03 }), 5);
check('bruit très fort (σ = 5 cm)', play({ phiAt: turns(5), noise: 0.05 }), [4, 5]);
check('profondeur très écrasée (z × 0,25)', play({ phiAt: turns(5), squash: 0.25 }), 5);
check('profondeur non écrasée (z × 1,3)', play({ phiAt: turns(5), squash: 1.3 }), 5);
check('webcam lente (15 fps)', play({ phiAt: turns(5), fps: 15 }), 5);
check('webcam rapide (60 fps)', play({ phiAt: turns(5), fps: 60 }), 5);

section('Anti-faux-positifs');
check('immobile de face', play({ phiAt: () => 0, noise: 0.02 }), 0);
check('immobile de dos', play({ phiAt: () => Math.PI, noise: 0.02 }), 0);
check('immobile de profil', play({ phiAt: () => Math.PI / 2, noise: 0.02 }), 0);
check('se dandine ±80° à 1 Hz', play({ phiAt: oscillate(80, 1) }), 0);
check('demi-tours répétés ±150° à 0,5 Hz', play({ phiAt: oscillate(150, 0.5) }), 0);
check('demi-tours répétés ±150° à 1 Hz', play({ phiAt: oscillate(150, 1) }), 0);
check('translation latérale (yaw fixe)', play({ phiAt: () => 0.3, noise: 0.02 }), 0);

section('Cas terrain');
check('2 tours horaire puis 2 anti-horaire',
  play({ phiAt: (t) => (t < 15 ? turns(2, 15)(t) : turns(2, 15)(15) - turns(2, 15)(t - 15)) }), 4);
check('1,94 tour puis 1,06 tour inverse (rien ne doit être perdu)',
  play({ phiAt: (t) => (t < 12 ? t * (1.94 / 12) * TAU : (1.94 * TAU) - (t - 12) * (1.11 / 18) * TAU) }), 2);
check('sort du cadre 1 s en plein tour', play({ phiAt: turns(5), dropout: [8000, 9000] }), 4);
check('micro-coupure de suivi (200 ms)', play({ phiAt: turns(5), dropout: [8000, 8200] }), 5);
check('3 tours puis s\'arrête 15 s',
  play({ phiAt: (t) => Math.min(t, 15) * (3.05 / 15) * TAU }), 3);
check('tour terminé pile au buzzer (tolérance ±1)',
  play({ phiAt: (t) => t * (5 / 30) * TAU, settleMs: 0 }), [4, 5]);

/* ---------------- caractérisation statistique ---------------- */

section('Taux de faux positifs selon l\'amplitude d\'oscillation');
console.log('    (252 manches par amplitude : 7 écrasements z × 4 bruits × 3 fréquences × 3 tirages)');
for (const amp of [90, 120, 150, 165, 175, 179]) {
  let bad = 0, tot = 0;
  seed = 1;
  for (const squash of [0.25, 0.4, 0.55, 0.7, 0.85, 1.0, 1.3])
    for (const noise of [0.01, 0.02, 0.03, 0.04])
      for (const hz of [0.4, 0.7, 1.1])
        for (let k = 0; k < 3; k++) {
          tot++;
          if (play({ phiAt: oscillate(amp, hz), noise, squash, settleMs: 0 }) > 0) bad++;
        }
  const pct = (100 * bad / tot);
  const bar = '█'.repeat(Math.round(pct / 2)) || '—';
  console.log(`    ±${String(amp).padStart(3)}°  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}
console.log('    Un tour valide fait 360° : à ±179° l\'écart est de 2°, sous le bruit de');
console.log('    mesure de MediaPipe. Indistinguable par nature — et à ce stade la personne');
console.log('    a de toute façon quasiment fait le tour.');

/* ---------------- verdict ---------------- */

const pass = results.filter(Boolean).length;
console.log('\n  ' + '─'.repeat(84));
console.log(`  ${pass === results.length ? '\x1b[32m' : '\x1b[31m'}${pass}/${results.length} tests passés\x1b[0m\n`);
process.exit(pass === results.length ? 0 : 1);
