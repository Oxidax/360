/**
 * Spin Challenge — serveur local (Node + Express)
 * ------------------------------------------------
 * Rôle :
 *   1. servir le front-end statique (public/)
 *   2. servir le runtime MediaPipe depuis node_modules (mode 100 % hors-ligne)
 *   3. exposer une mini API de classement persistée dans leaderboard.json
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'leaderboard.json');

/* ------------------------------------------------------------------ */
/*  La roue de la fortune                                              */
/* ------------------------------------------------------------------ */

// Chaque case de la roue = un multiplicateur. Le tirage est UNIFORME sur les
// cases : la roue affichée est donc exactement la table de probabilités, il n'y
// a aucun écart entre ce que le joueur voit et ses vraies chances.
//
// Par défaut, 20 cases qui alternent perte / gain — le ×10 et le ×5 sont
// encadrés de ✕0, ce qui produit naturellement des « presque gagné ».
//   ✕0 : 10/20 = 50 %   ×2 : 5/20 = 25 %   ×3 : 3/20 = 15 %
//   ×5 :  1/20 =  5 %   ×10 : 1/20 = 5 %
// Espérance = 1,70 : jouer est statistiquement rentable, c'est assumé — on veut
// que les gens tentent. Pour en faire un vrai dilemme, ajoute des ✕0.
const WHEEL = (process.env.WHEEL || '0,2,0,3,0,2,0,5,0,2,0,3,0,2,0,10,0,2,0,3')
  .split(',')
  .map((v) => Number(v.trim()));

if (WHEEL.length < 4 || WHEEL.length > 40 || WHEEL.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) {
  console.error('[roue] WHEEL invalide :', process.env.WHEEL);
  process.exit(1);
}

// Une manche ne peut plus être jouée à la roulette au-delà de ce délai
// (évite de rejouer un vieux score en rappelant l'API).
const GAMBLE_WINDOW_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ */
/*  Persistance : un simple JSON, écrit de façon atomique              */
/* ------------------------------------------------------------------ */

/** @type {{id:string, name:string, spins:number, durationMs:number, date:string}[]} */
let scores = [];
let writeQueue = Promise.resolve(); // sérialise les écritures concurrentes

function loadScores() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    scores = Array.isArray(parsed) ? parsed : (parsed.scores || []);
    console.log(`[db] ${scores.length} score(s) chargé(s) depuis leaderboard.json`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[db] fichier illisible, on repart à zéro :', err.message);
    }
    scores = [];
    fs.writeFileSync(DB_FILE, '[]', 'utf8');
  }
}

function saveScores() {
  // Écriture atomique (tmp + rename) : le fichier ne peut pas être corrompu
  // même si on coupe le serveur en plein événement.
  writeQueue = writeQueue
    .then(async () => {
      const tmp = `${DB_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(scores, null, 2), 'utf8');
      await fsp.rename(tmp, DB_FILE);
    })
    .catch((err) => console.error('[db] échec écriture :', err));
  return writeQueue;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function sanitizeName(input) {
  return String(input ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

/** Score final = tours × multiplicateur. Les anciennes entrées n'ont pas de
 *  champ `score` : on retombe sur le nombre de tours. */
const finalScore = (s) => (Number.isFinite(s.score) ? s.score : s.spins);

/** Tri : meilleur score, puis le plus de tours réels (le mérite avant la
 *  chance en cas d'égalité), puis le plus rapide, puis le plus ancien. */
function rank(list) {
  return [...list].sort(
    (a, b) =>
      finalScore(b) - finalScore(a) ||
      b.spins - a.spins ||
      a.durationMs - b.durationMs ||
      new Date(a.date) - new Date(b.date)
  );
}

/** Autorise les actions destructives uniquement depuis la machine locale. */
function localOnly(req, res, next) {
  const ip = req.ip || '';
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'Action autorisée uniquement depuis la borne.' });
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const app = express();
app.use(express.json({ limit: '16kb' }));

// Pas de cache sur le HTML/JS : tes modifs sont prises en compte au simple refresh.
app.use((req, res, next) => {
  if (req.path === '/' || /\.(html|js|css)$/.test(req.path)) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Front-end
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// Runtime MediaPipe servi depuis node_modules → aucune dépendance CDN au runtime.
app.use(
  '/vendor/tasks-vision',
  express.static(path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision'), {
    immutable: true,
    maxAge: '7d',
  })
);

/* ----------------------------- API -------------------------------- */

// Config partagée avec le client (durée de manche modifiable sans toucher au JS)
app.get('/api/config', (req, res) => {
  res.json({
    roundDurationMs: Number(process.env.ROUND_MS || 15000),
    countdownSeconds: Number(process.env.COUNTDOWN || 5),
    topCount: 10,
    wheel: WHEEL,
  });
});

// Classement
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 100);
  const sorted = rank(scores);
  res.json({
    total: scores.length,
    top: sorted.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 })),
  });
});

// Enregistrement d'un score
app.post('/api/score', async (req, res) => {
  const name = sanitizeName(req.body?.name);
  const spins = Number(req.body?.spins);
  const durationMs = Number(req.body?.durationMs);

  if (!name) return res.status(400).json({ error: 'Pseudo manquant.' });
  if (!Number.isFinite(spins) || spins < 0 || spins > 500) {
    return res.status(400).json({ error: 'Nombre de tours invalide.' });
  }

  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    spins: Math.round(spins),
    score: Math.round(spins),   // score retenu au classement (= tours tant qu'on n'a pas joué)
    multiplier: null,           // null = le joueur n'a pas tenté la roulette
    gambled: false,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    date: new Date().toISOString(),
  };

  scores.push(entry);
  await saveScores();

  const sorted = rank(scores);
  const position = sorted.findIndex((s) => s.id === entry.id) + 1;

  console.log(`[score] ${entry.name} — ${entry.spins} tour(s) → #${position}`);

  res.status(201).json({
    entry,
    rank: position,
    total: scores.length,
    top: sorted.slice(0, 10).map((s, i) => ({ ...s, rank: i + 1 })),
  });
});

// Roulette : le joueur mise son score. Le tirage est fait ICI, jamais dans le
// navigateur — sinon n'importe qui peut forcer le résultat depuis la console,
// ou relancer le tirage en rechargeant la page jusqu'au ×10.
app.post('/api/gamble', async (req, res) => {
  const id = String(req.body?.id ?? '');
  const entry = scores.find((s) => s.id === id);

  if (!entry) return res.status(404).json({ error: 'Manche introuvable.' });
  if (entry.gambled) return res.status(409).json({ error: 'Cette manche a déjà été jouée.' });
  if (Date.now() - new Date(entry.date).getTime() > GAMBLE_WINDOW_MS) {
    return res.status(410).json({ error: 'Trop tard pour jouer cette manche.' });
  }
  if (entry.spins <= 0) return res.status(400).json({ error: 'Rien à miser.' });

  // Tirage uniforme sur les cases : les chances sont exactement celles que
  // le joueur voit sur la roue.
  const slot = crypto.randomInt(WHEEL.length);
  const multiplier = WHEEL[slot];

  entry.multiplier = multiplier;
  entry.score = entry.spins * multiplier;
  entry.gambled = true;
  await saveScores();

  const sorted = rank(scores);
  const position = sorted.findIndex((s) => s.id === entry.id) + 1;

  console.log(`[roulette] ${entry.name} mise ${entry.spins} → case ${slot} (×${multiplier}) = ${entry.score}`);

  res.json({
    slot,
    multiplier,
    score: entry.score,
    rank: position,
    total: scores.length,
    top: sorted.slice(0, 10).map((s, i) => ({ ...s, rank: i + 1 })),
  });
});

// Remise à zéro entre deux événements (depuis la borne uniquement)
app.delete('/api/leaderboard', localOnly, async (req, res) => {
  let backupName = null;
  if (scores.length) {
    backupName = `leaderboard.backup-${Date.now()}.json`;
    await fsp.writeFile(path.join(ROOT, backupName), JSON.stringify(scores, null, 2), 'utf8');
  }
  scores = [];
  await saveScores();
  console.log(`[db] classement réinitialisé (sauvegarde : ${backupName || 'aucune'})`);
  res.json({ ok: true, backup: backupName });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[erreur]', err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

/* ------------------------------------------------------------------ */

loadScores();

app.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  console.log('');
  console.log('  🌀  SPIN CHALLENGE — serveur démarré');
  console.log('  ───────────────────────────────────────────');
  console.log(`  ➜  Borne   : http://localhost:${PORT}`);
  if (lan) console.log(`  ➜  Réseau  : http://${lan.address}:${PORT}   (webcam KO hors localhost en HTTP)`);
  console.log(`  ➜  Scores  : ${DB_FILE}`);
  console.log('  ───────────────────────────────────────────');
  console.log('');
});
