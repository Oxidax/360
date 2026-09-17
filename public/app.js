/* =====================================================================
 *  SPIN CHALLENGE — logique client
 *  ---------------------------------------------------------------
 *  1. Chargement de MediaPipe Pose Landmarker (servi en local)
 *  2. Estimation de l'orientation du buste (yaw) à partir des épaules
 *  3. Comptage des tours à 360° avec anti-faux-positifs
 *  4. Chronomètre, HUD, appels API classement
 * ===================================================================== */

import { FilesetResolver, PoseLandmarker }
  from '/vendor/tasks-vision/vision_bundle.mjs';

/* ------------------------------------------------------------------ */
/*  CONFIGURATION — tout se règle ici                                  */
/* ------------------------------------------------------------------ */

const CONFIG = {
  /* --- Manche --- */
  roundDurationMs: 15_000,
  countdownSeconds: 5,

  /* --- Détection de pose --- */
  modelPath: '/models/pose_landmarker_lite.task',
  wasmPath: '/vendor/tasks-vision/wasm',
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,

  /* --- Algorithme de rotation --- */
  // Les z de MediaPipe sont légèrement « écrasés » par rapport aux x :
  // ce gain rééquilibre les deux axes pour que le profil soit franc.
  zGain: 1.8,
  // Lissage exponentiel du vecteur d'épaules (0 = figé, 1 = aucun lissage).
  smoothing: 0.40,
  // Longueur mini du segment projeté (m) en dessous de laquelle l'angle
  // n'a pas de sens (personne trop loin, pose aberrante).
  minSegment: 0.06,
  // Pondération épaules / hanches dans l'estimation du yaw.
  shoulderWeight: 0.65,
  hipWeight: 0.35,
  // Variation d'angle max acceptée entre 2 frames (garde-fou anti-glitch).
  // 60° @30fps ≈ 5 tours/seconde : impossible humainement, donc c'est un bug.
  maxStepDeg: 60,
  // Rotation nécessaire pour « verrouiller » un sens de rotation.
  directionLockDeg: 40,
  // Retour en arrière toléré, mesuré depuis le point le plus avancé du tour
  // en cours, avant de considérer que la personne repart en sens inverse.
  // Généreux volontairement : l'anti-triche ne repose PAS sur ce seuil (il
  // faut 360° NETS pour marquer) mais sur le cumul signé. Un seuil trop bas
  // annulerait les tours des personnes qui tournent de façon saccadée.
  reverseToleranceDeg: 110,
  // Un tour complet ne peut pas être plus rapide que ça (anti-glitch).
  minTurnMs: 400,
  // Au-delà, on considère le suivi perdu et on réinitialise l'angle de
  // référence (évite de compter un « saut » quand la personne revient).
  lostTrackResetMs: 700,

  /* --- Roulette --- */
  // Disposition par défaut, écrasée par /api/config : le serveur fait foi.
  wheel: [0, 2, 0, 3, 0, 2, 0, 5, 0, 2, 0, 3, 0, 2, 0, 10, 0, 2, 0, 3],
  wheelSpinMs: 5200,
  wheelTurns: 7,
  wheelTickMinMs: 38,   // anti-mitraillette sur les clics du début

  /* --- Divers --- */
  hintDelayMs: 700,
  apiTimeoutMs: 5000,
};

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const LM = { NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_HIP: 23, R_HIP: 24 };

/* ------------------------------------------------------------------ */
/*  COMPTEUR DE TOURS                                                  */
/* ------------------------------------------------------------------ */

/**
 * Principe
 * --------
 * MediaPipe fournit des `worldLandmarks` : des coordonnées 3D en mètres.
 * On projette le segment épaule droite → épaule gauche sur le plan
 * horizontal (x = droite/gauche de l'image, z = profondeur) :
 *
 *        θ = atan2( z_droite - z_gauche , x_gauche - x_droite )
 *
 *   θ ≈ 0°     → épaule gauche à droite de l'image  = personne DE FACE
 *   θ ≈ ±90°   → les épaules sont l'une derrière l'autre = PROFIL
 *   θ ≈ ±180°  → les x sont inversés                = personne DE DOS
 *
 * θ est donc un angle continu et non un simple booléen face/dos : en le
 * « déroulant » image par image (unwrapping) on obtient la rotation
 * cumulée réelle. Un tour = 360° cumulés **dans le même sens**, en étant
 * passé par les 4 secteurs face → profil → dos → profil.
 */
class SpinCounter {
  constructor(cfg) {
    this.cfg = cfg;
    this.maxStep = cfg.maxStepDeg * DEG;
    this.dirLock = cfg.directionLockDeg * DEG;
    this.reverseTol = cfg.reverseToleranceDeg * DEG;
    this.reset();
  }

  reset() {
    this.vec = null;          // vecteur d'orientation lissé {x, z}
    this.theta = 0;           // yaw courant (rad)
    this.lastTheta = null;    // yaw de la frame précédente
    this.accum = 0;           // rotation cumulée signée, non bornée (rad)
    this.anchor = 0;          // valeur de `accum` au début du tour en cours
    this.dir = 0;             // sens verrouillé : -1, 0 (indéterminé), +1
    this.lowMark = 0;         // extrêmes de `accum` tant qu'aucun sens n'est
    this.highMark = 0;        // verrouillé → repèrent le point de rebroussement
    this.peakProg = 0;        // avancement max atteint dans le tour en cours
    this.sectors = new Set(); // secteurs traversés pendant le tour en cours
    this.lastSector = null;
    this.turnStartedAt = 0;
    this.spins = 0;
    this.progress = 0;        // avancement du tour en cours, 0 → 1
    this.quality = 0;         // stabilité de l'estimation, 0 → 1
    this.lastValidAt = 0;
    this.facing = '—';
    this.tracked = false;
  }

  clearSectors() {
    this.sectors.clear();
    this.lastSector = null;
  }

  /** Personne non détectée sur cette frame : on gèle l'état. */
  miss() {
    this.tracked = false;
    this.quality = 0;
    return null;
  }

  /**
   * @param {Array<{x:number,y:number,z:number}>} world worldLandmarks (mètres)
   * @param {number} now  timestamp performance.now()
   * @returns {'spin'|null} 'spin' quand un tour vient d'être validé
   */
  update(world, now) {
    const c = this.cfg;
    const SL = world[LM.L_SHOULDER];
    const SR = world[LM.R_SHOULDER];
    if (!SL || !SR) return this.miss();

    /* --- 1. Vecteur d'orientation à partir des épaules --------------- */
    // x : décalage horizontal gauche↔droite dans l'image
    // z : décalage en profondeur (z MediaPipe : plus petit = plus proche)
    const sx = SL.x - SR.x;
    const sz = (SR.z - SL.z) * c.zGain;
    const sLen = Math.hypot(sx, sz);
    if (sLen < c.minSegment) return this.miss(); // pose inexploitable

    let vx = sx / sLen;
    let vz = sz / sLen;

    /* --- 2. Les hanches stabilisent l'estimation --------------------- */
    // Le bassin tourne avec le buste : c'est un second témoin quasi gratuit,
    // utile quand une épaule est mal estimée (bras levés, occlusion).
    const HL = world[LM.L_HIP];
    const HR = world[LM.R_HIP];
    if (HL && HR) {
      const hx = HL.x - HR.x;
      const hz = (HR.z - HL.z) * c.zGain;
      const hLen = Math.hypot(hx, hz);
      if (hLen > c.minSegment) {
        const ux = hx / hLen;
        const uz = hz / hLen;
        // On ne fusionne que si les hanches confirment les épaules (< 90°
        // d'écart) : sinon c'est que l'une des deux est aberrante.
        if (ux * vx + uz * vz > 0) {
          vx = vx * c.shoulderWeight + ux * c.hipWeight;
          vz = vz * c.shoulderWeight + uz * c.hipWeight;
          const n = Math.hypot(vx, vz) || 1;
          vx /= n; vz /= n;
        }
      }
    }

    /* --- 3. Lissage temporel ---------------------------------------- */
    // On lisse le VECTEUR, pas l'angle : pas de discontinuité à ±180°.
    if (!this.vec || !this.tracked) {
      this.vec = { x: vx, z: vz };
    } else {
      this.vec.x += (vx - this.vec.x) * c.smoothing;
      this.vec.z += (vz - this.vec.z) * c.smoothing;
    }
    // La norme du vecteur lissé est un excellent indicateur de confiance :
    // proche de 1 = direction stable, proche de 0 = l'estimation part
    // dans tous les sens.
    const mag = Math.hypot(this.vec.x, this.vec.z);
    this.quality = Math.min(1, mag);
    this.tracked = true;

    const theta = Math.atan2(this.vec.z, this.vec.x);
    this.theta = theta;
    this.facing = SpinCounter.labelOf(theta);

    /* --- 4. Déroulement de l'angle (unwrapping) --------------------- */
    const lost = this.lastTheta === null || (now - this.lastValidAt) > c.lostTrackResetMs;
    if (lost) {
      // Ré-acquisition : on repart de l'angle courant sans rien cumuler,
      // sinon l'absence de la personne se traduirait par un faux tour.
      this.lastTheta = theta;
      this.anchor = this.accum;
      this.lowMark = this.highMark = this.accum;
      this.dir = 0;
      this.peakProg = 0;
      this.clearSectors();
      this.progress = 0;
    }

    let d = theta - this.lastTheta;
    d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI; // ramène dans ]-π, π]
    if (Math.abs(d) > this.maxStep) d = Math.sign(d) * this.maxStep; // glitch
    this.accum += d;
    this.lastTheta = theta;
    this.lastValidAt = now;

    /* --- 5. Verrouillage du sens de rotation ------------------------ */
    if (this.dir === 0) {
      // Tant qu'aucun sens n'est verrouillé on mémorise les deux extrêmes
      // atteints : le tour sera compté depuis le point de REBROUSSEMENT et
      // non depuis l'endroit où l'on a détecté le mouvement. Sans ça, une
      // personne qui repart dans l'autre sens perdrait tout le début de son
      // nouveau tour.
      if (this.accum < this.lowMark) this.lowMark = this.accum;
      if (this.accum > this.highMark) this.highMark = this.accum;

      if (this.accum - this.lowMark > this.dirLock) {
        this.dir = 1;
        this.anchor = this.lowMark;
      } else if (this.highMark - this.accum > this.dirLock) {
        this.dir = -1;
        this.anchor = this.highMark;
      } else {
        this.progress = 0;
        return null; // mouvement encore trop faible pour décider d'un sens
      }
      this.turnStartedAt = now;
      this.peakProg = 0;
      this.clearSectors();
    }

    /* --- 6. Validation du tour -------------------------------------- */
    let prog = (this.accum - this.anchor) * this.dir;

    if (prog < this.peakProg - this.reverseTol) {
      // Demi-tour franc : la personne repart dans l'autre sens. Le tour en
      // cours est annulé (impossible de « gratter » des tours en oscillant)
      // et le sens suivant repartira du point de rebroussement.
      const turnaround = this.anchor + this.dir * this.peakProg;
      this.lowMark = Math.min(turnaround, this.accum);
      this.highMark = Math.max(turnaround, this.accum);
      this.dir = 0;
      this.peakProg = 0;
      this.clearSectors();
      this.progress = 0;
      return null;
    }

    if (prog > this.peakProg) this.peakProg = prog;
    prog = Math.max(0, prog);

    // Secteurs traversés : 0 = face, 1 = profil, 2 = dos, 3 = profil.
    // On remplit l'INTERVALLE entre le secteur précédent et le secteur
    // courant, et non le seul secteur courant : après un rebroussement le
    // tour démarre au milieu d'un secteur, et sans ça le secteur 0 ne serait
    // jamais marqué — plus aucun tour ne pourrait être validé ensuite.
    const sec = Math.max(0, Math.min(3, Math.floor(prog / (Math.PI / 2))));
    const from = this.lastSector === null ? 0 : Math.min(this.lastSector, sec);
    for (let s = from; s <= Math.max(this.lastSector ?? sec, sec); s++) this.sectors.add(s);
    this.lastSector = sec;

    this.progress = Math.min(1, prog / TAU);

    const allSectors = this.sectors.size >= 4;          // face→profil→dos→profil
    const longEnough = now - this.turnStartedAt >= c.minTurnMs;

    if (prog >= TAU && allSectors && longEnough) {
      this.spins++;
      this.anchor += TAU * this.dir; // le dépassement est reporté sur le tour suivant
      this.peakProg = Math.max(0, this.peakProg - TAU);
      this.turnStartedAt = now;
      this.clearSectors();
      this.progress = 0;
      return 'spin';
    }
    return null;
  }

  static labelOf(theta) {
    const a = Math.abs(theta);
    if (a < 50 * DEG) return 'FACE';
    if (a > 130 * DEG) return 'DOS';
    return 'PROFIL';
  }
}

/* ------------------------------------------------------------------ */
/*  DOM                                                                */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const el = {
  screens: {
    home: $('#screen-home'),
    game: $('#screen-game'),
    gamble: $('#screen-gamble'),
    board: $('#screen-board'),
  },
  // accueil
  homeForm: $('#homeForm'),
  pseudo: $('#pseudo'),
  homeError: $('#homeError'),
  btnStart: $('#btnStart'),
  btnSeeBoard: $('#btnSeeBoard'),
  engineStatus: $('#engineStatus'),
  homeDuration: $('#homeDuration'),
  // jeu
  cam: $('#cam'),
  overlay: $('#overlay'),
  spinCount: $('#spinCount'),
  timeLeft: $('#timeLeft'),
  timeBar: $('#timeBar'),
  ring: $('#ringProgress'),
  hint: $('#hint'),
  flash: $('#flash'),
  btnStop: $('#btnStop'),
  countdown: $('#countdown'),
  countdownNum: $('#countdownNum'),
  countdownMsg: $('#countdownMsg'),
  debug: $('#debug'),
  // roulette
  gambleCard: $('#gambleCard'),
  gambleName: $('#gambleName'),
  gambleScore: $('#gambleScore'),
  gambleActions: $('#gambleActions'),
  gambleVerdict: $('#gambleVerdict'),
  gambleDetail: $('#gambleDetail'),
  bankAmount: $('#bankAmount'),
  btnBank: $('#btnBank'),
  btnGamble: $('#btnGamble'),
  btnAfterGamble: $('#btnAfterGamble'),
  wheelGroup: $('#wheelGroup'),
  wheelHub: $('#wheelHub'),
  hubText: $('#hubText'),
  pointer: $('#pointer'),
  confetti: $('#confetti'),
  // classement
  boardBody: $('#boardBody'),
  boardTotal: $('#boardTotal'),
  resultBanner: $('#resultBanner'),
  resultName: $('#resultName'),
  resultSpins: $('#resultSpins'),
  resultUnit: $('#resultUnit'),
  resultRank: $('#resultRank'),
  btnNewPlayer: $('#btnNewPlayer'),
};

const ctx = el.overlay.getContext('2d');
const confettiCtx = el.confetti.getContext('2d');
const RING_CIRCUMFERENCE = 2 * Math.PI * 24;

/* ------------------------------------------------------------------ */
/*  ÉTAT GLOBAL                                                        */
/* ------------------------------------------------------------------ */

const state = {
  phase: 'home',          // home | countdown | playing | ended
  playerName: '',
  startedAt: 0,
  elapsedMs: 0,
  rafId: 0,
  endTimer: 0,
  lastVideoTime: -1,
  lastUiAt: 0,
  poseLostSince: 0,
  debug: false,
};

const counter = new SpinCounter(CONFIG);
let detector = null;
let detectorPromise = null;
let stream = null;

/* ------------------------------------------------------------------ */
/*  NAVIGATION ENTRE ÉCRANS                                            */
/* ------------------------------------------------------------------ */

function showScreen(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('active', key === name);
  }
}

/* ------------------------------------------------------------------ */
/*  SON (généré, aucun fichier audio à embarquer)                      */
/* ------------------------------------------------------------------ */

let audioCtx = null;

/** Note unique, avec glissando optionnel. Tout est synthétisé : aucun fichier. */
function tone({ freq, to = null, ms = 150, type = 'sine', gain = 0.12, delay = 0 }) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + ms / 1000);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  } catch { /* le son n'est pas critique */ }
}

function beep(freq = 880, ms = 120, type = 'sine', gain = 0.12) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    osc.connect(g).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* le son n'est pas critique */ }
}

/* ------------------------------------------------------------------ */
/*  CHARGEMENT DU MOTEUR DE DÉTECTION                                  */
/* ------------------------------------------------------------------ */

async function loadDetector() {
  if (detector) return detector;
  if (detectorPromise) return detectorPromise;

  detectorPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(CONFIG.wasmPath);

    const options = (delegate) => ({
      baseOptions: { modelAssetPath: CONFIG.modelPath, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: CONFIG.minPoseDetectionConfidence,
      minPosePresenceConfidence: CONFIG.minPosePresenceConfidence,
      minTrackingConfidence: CONFIG.minTrackingConfidence,
      outputSegmentationMasks: false,
    });

    try {
      detector = await PoseLandmarker.createFromOptions(vision, options('GPU'));
    } catch (err) {
      console.warn('[pose] GPU indisponible, bascule sur CPU :', err);
      detector = await PoseLandmarker.createFromOptions(vision, options('CPU'));
    }
    return detector;
  })();

  return detectorPromise;
}

/* ------------------------------------------------------------------ */
/*  WEBCAM                                                             */
/* ------------------------------------------------------------------ */

async function startCamera() {
  if (stream && stream.active) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  el.cam.srcObject = stream;
  await el.cam.play();
  await new Promise((res) => {
    if (el.cam.videoWidth) return res();
    el.cam.onloadedmetadata = () => res();
  });
  el.overlay.width = el.cam.videoWidth;
  el.overlay.height = el.cam.videoHeight;
}

/* ------------------------------------------------------------------ */
/*  BOUCLE DE JEU                                                      */
/* ------------------------------------------------------------------ */

function tick() {
  if (state.phase !== 'countdown' && state.phase !== 'playing') return;
  state.rafId = requestAnimationFrame(tick);

  const now = performance.now();

  // MediaPipe n'a besoin d'analyser que les nouvelles frames vidéo.
  if (detector && el.cam.readyState >= 2 && el.cam.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = el.cam.currentTime;

    let result = null;
    try {
      result = detector.detectForVideo(el.cam, now);
    } catch (err) {
      console.error('[pose] detectForVideo', err);
    }

    const world = result?.worldLandmarks?.[0];
    const norm = result?.landmarks?.[0];

    if (world && world.length > LM.R_HIP) {
      state.poseLostSince = 0;
      if (state.phase === 'playing') {
        if (counter.update(world, now) === 'spin') onSpinDetected();
      } else {
        // Pendant le décompte on met déjà à jour l'angle pour que le
        // premier tour soit mesuré proprement dès la 1re frame de jeu.
        counter.update(world, now);
      }
    } else {
      counter.miss();
      if (!state.poseLostSince) state.poseLostSince = now;
    }

    drawOverlay(norm);
  }

  if (state.phase === 'playing') {
    state.elapsedMs = now - state.startedAt;
    if (state.elapsedMs >= CONFIG.roundDurationMs) {
      endRound('time');
      return;
    }
  }

  // Le HUD n'a pas besoin d'être rafraîchi à 60 fps.
  if (now - state.lastUiAt > 45) {
    state.lastUiAt = now;
    updateHud(now);
  }
}

function onSpinDetected() {
  el.spinCount.textContent = counter.spins;
  el.spinCount.classList.remove('pop');
  void el.spinCount.offsetWidth; // force le redémarrage de l'animation
  el.spinCount.classList.add('pop');
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
  beep(660 + Math.min(counter.spins, 12) * 45, 130, 'triangle', 0.16);
}

function updateHud(now) {
  if (state.phase === 'playing') {
    const left = Math.max(0, CONFIG.roundDurationMs - state.elapsedMs);
    el.timeLeft.textContent = (left / 1000).toFixed(1);
    const ratio = left / CONFIG.roundDurationMs;
    el.timeBar.style.transform = `scaleX(${ratio})`;
    el.timeBar.classList.toggle('low', left <= 5000);
    el.timeLeft.style.color = left <= 5000 ? 'var(--bad)' : '';
  }

  el.ring.setAttribute(
    'stroke-dashoffset',
    (RING_CIRCUMFERENCE * (1 - counter.progress)).toFixed(2)
  );

  // Message d'aide contextuel
  let hint = '';
  if (state.poseLostSince && now - state.poseLostSince > CONFIG.hintDelayMs) {
    hint = '👀 Reviens dans le cadre !';
  } else if (counter.tracked && counter.quality < 0.45) {
    hint = '🙆 Recule un peu et garde les bras le long du corps';
  }
  el.hint.textContent = hint;
  el.hint.style.opacity = hint ? '1' : '0';

  if (state.debug) {
    el.debug.textContent =
      `phase    ${state.phase}\n` +
      `θ        ${(counter.theta / DEG).toFixed(1).padStart(7)}°  (${counter.facing})\n` +
      `cumul    ${(counter.accum / DEG).toFixed(1).padStart(7)}°\n` +
      `sens     ${counter.dir === 0 ? '—' : counter.dir > 0 ? 'horaire' : 'anti-horaire'}\n` +
      `secteurs ${[...counter.sectors].sort().join(',') || '—'}\n` +
      `progress ${(counter.progress * 100).toFixed(0)}%\n` +
      `qualité  ${counter.quality.toFixed(2)}\n` +
      `tours    ${counter.spins}`;
  }
}

/* ------------------------------------------------------------------ */
/*  RENDU DU SQUELETTE                                                 */
/* ------------------------------------------------------------------ */

const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],  // buste
  [11, 13], [13, 15], [12, 14], [14, 16],  // bras
  [23, 25], [25, 27], [24, 26], [26, 28],  // jambes
];

function drawOverlay(norm) {
  const w = el.overlay.width;
  const h = el.overlay.height;
  ctx.clearRect(0, 0, w, h);
  if (!norm) return;

  const color =
    counter.facing === 'FACE' ? '#22d3ee' :
    counter.facing === 'DOS' ? '#a855f7' : '#fbbf24';

  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(3, w * 0.005);
  ctx.strokeStyle = 'rgba(226,232,240,.45)';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    const p = norm[a], q = norm[b];
    if (!p || !q) continue;
    ctx.moveTo(p.x * w, p.y * h);
    ctx.lineTo(q.x * w, q.y * h);
  }
  ctx.stroke();

  // La ligne d'épaules est mise en avant : c'est elle qui pilote le compteur.
  const SL = norm[LM.L_SHOULDER], SR = norm[LM.R_SHOULDER];
  if (SL && SR) {
    ctx.lineWidth = Math.max(6, w * 0.011);
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(SL.x * w, SL.y * h);
    ctx.lineTo(SR.x * w, SR.y * h);
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const p of [SL, SR]) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, ctx.lineWidth * 0.75, 0, TAU);
      ctx.fill();
    }
  }
}

/* ------------------------------------------------------------------ */
/*  DÉROULÉ D'UNE MANCHE                                               */
/* ------------------------------------------------------------------ */

function setCountdownOverlay(visible, num, msg) {
  el.countdown.style.display = visible ? 'grid' : 'none';
  if (num !== undefined) {
    el.countdownNum.textContent = num;
    // Le dégradé (background-clip:text) n'est lisible que sur des chiffres.
    el.countdownNum.classList.toggle('plain', !/^(\d+|GO.*)$/.test(String(num)));
    el.countdownNum.style.animation = 'none';
    void el.countdownNum.offsetWidth;
    el.countdownNum.style.animation = '';
  }
  if (msg !== undefined) el.countdownMsg.innerHTML = msg;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startRound(name) {
  state.playerName = name;
  state.phase = 'countdown';
  state.lastVideoTime = -1;
  state.poseLostSince = 0;
  counter.reset();

  el.spinCount.textContent = '0';
  el.timeLeft.textContent = (CONFIG.roundDurationMs / 1000).toFixed(1);
  el.timeBar.style.transform = 'scaleX(1)';
  el.timeBar.classList.remove('low');
  el.hint.style.opacity = '0';
  showScreen('game');
  setCountdownOverlay(true, '…', 'Démarrage de la caméra…');

  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    setCountdownOverlay(true, '🚫',
      `Impossible d'accéder à la webcam.<br><span class="text-sm text-slate-400">${
        err.name === 'NotAllowedError'
          ? 'Autorise la caméra dans le navigateur puis réessaie.'
          : escapeHtml(err.message)
      }</span><br><button id="camBack" class="btn btn-ghost mt-5 px-6 py-3">Retour</button>`);
    $('#camBack')?.addEventListener('click', backToHome);
    return;
  }

  setCountdownOverlay(true, '…', 'Chargement du moteur de détection…');
  try {
    await loadDetector();
  } catch (err) {
    console.error(err);
    setCountdownOverlay(true, '🚫',
      `Moteur de détection indisponible.<br><span class="text-sm text-slate-400">${escapeHtml(err.message)}</span>` +
      `<br><button id="camBack" class="btn btn-ghost mt-5 px-6 py-3">Retour</button>`);
    $('#camBack')?.addEventListener('click', backToHome);
    return;
  }

  // La boucle tourne déjà pendant le décompte : on attend de « voir » la
  // personne avant de lancer le chrono.
  tick();

  setCountdownOverlay(true, '🙂', 'Place-toi <b>face à la caméra</b>, en pied');
  const deadline = performance.now() + 15000;
  while (!counter.tracked && performance.now() < deadline) {
    if (state.phase !== 'countdown') return; // annulé entre-temps
    await wait(100);
  }

  for (let i = CONFIG.countdownSeconds; i >= 1; i--) {
    if (state.phase !== 'countdown') return;
    setCountdownOverlay(true, i, 'Prêt&nbsp;?');
    beep(520, 90, 'sine', 0.1);
    await wait(1000);
  }
  if (state.phase !== 'countdown') return;

  setCountdownOverlay(true, 'GO !', 'Tourne&nbsp;!');
  beep(1046, 220, 'square', 0.14);
  await wait(400);

  setCountdownOverlay(false);
  counter.reset();
  state.startedAt = performance.now();
  state.elapsedMs = 0;
  state.phase = 'playing';
  // Échéance de secours indépendante de requestAnimationFrame : si l'onglet
  // passe en arrière-plan, le navigateur gèle la boucle de rendu et la manche
  // ne se terminerait jamais toute seule.
  clearTimeout(state.endTimer);
  state.endTimer = setTimeout(() => endRound('time'), CONFIG.roundDurationMs + 50);
}

async function endRound(reason) {
  if (state.phase === 'ended') return;
  const spins = counter.spins;
  const durationMs = Math.round(
    reason === 'time' ? CONFIG.roundDurationMs : Math.min(state.elapsedMs, CONFIG.roundDurationMs)
  );
  state.phase = 'ended';
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.endTimer);
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);

  beep(392, 160, 'sine', 0.14);
  setTimeout(() => beep(523, 320, 'sine', 0.14), 170);

  if (reason === 'abort') { backToHome(); return; }

  await submitScore(state.playerName, spins, durationMs);
}

function backToHome() {
  state.phase = 'home';
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.endTimer);
  setCountdownOverlay(false);
  el.resultBanner.classList.add('hidden');
  showScreen('home');
  el.pseudo.value = '';
  el.homeError.textContent = '';
  setTimeout(() => el.pseudo.focus(), 250);
}

/* ------------------------------------------------------------------ */
/*  ROULETTE — le joueur peut miser son score                          */
/* ------------------------------------------------------------------ */

/** Habillage de chaque multiplicateur. */
const SLOT_STYLE = {
  0:  { fill: '#3f0d18', edge: '#9f1239', ink: '#fda4af', label: '✕0' },
  2:  { fill: '#083344', edge: '#0891b2', ink: '#67e8f9', label: '×2' },
  3:  { fill: '#2e1065', edge: '#8b5cf6', ink: '#c4b5fd', label: '×3' },
  5:  { fill: '#4a1d03', edge: '#ea580c', ink: '#fdba74', label: '×5' },
  10: { fill: '#553b00', edge: '#facc15', ink: '#fde047', label: '×10' },
};
const styleOf = (m) => SLOT_STYLE[m] || { fill: '#1e293b', edge: '#64748b', ink: '#e2e8f0', label: `×${m}` };

/** Manche en attente de décision (encaisser ou miser). */
let pending = null;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Construit la roue en SVG à partir de la table du serveur. */
function buildWheel() {
  const slots = CONFIG.wheel;
  const n = slots.length;
  const step = 360 / n;
  const CX = 200, CY = 200, R = 192;
  const rad = (deg) => (deg - 90) * DEG;           // 0° = midi
  const pt = (deg, r) => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))];

  el.wheelGroup.textContent = '';

  const defs = document.createElementNS(SVG_NS, 'defs');
  defs.innerHTML =
    '<filter id="jackpotGlow" x="-30%" y="-30%" width="160%" height="160%">' +
    '<feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#facc15" flood-opacity="0.85"/>' +
    '</filter>';
  el.wheelGroup.appendChild(defs);

  slots.forEach((mult, i) => {
    const st = styleOf(mult);
    const a0 = i * step;
    const a1 = a0 + step;
    const [x0, y0] = pt(a0, R);
    const [x1, y1] = pt(a1, R);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M ${CX} ${CY} L ${x0.toFixed(2)} ${y0.toFixed(2)} ` +
      `A ${R} ${R} 0 ${step > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`);
    path.setAttribute('fill', st.fill);
    path.setAttribute('stroke', st.edge);
    path.setAttribute('stroke-width', mult >= 5 ? '3.5' : '2');
    // La couleur porte l'info avant le texte : rouge sombre = perdu,
    // or = jackpot. C'est ce que l'œil lit quand la roue tourne vite.
    if (mult >= 5) path.setAttribute('filter', 'url(#jackpotGlow)');
    el.wheelGroup.appendChild(path);

    const mid = a0 + step / 2;
    const [tx, ty] = pt(mid, R * 0.7);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', tx.toFixed(2));
    label.setAttribute('y', ty.toFixed(2));
    label.setAttribute('fill', st.ink);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('font-size', mult >= 10 ? '27' : '24');
    // Texte radial (comme une vraie roue de loterie). Sur la moitié gauche on
    // bascule de 180° sinon il se lit à l'envers.
    const upright = mid > 0 && mid < 180 ? mid - 90 : mid + 90;
    label.setAttribute('transform', `rotate(${upright.toFixed(2)} ${tx.toFixed(2)} ${ty.toFixed(2)})`);
    label.textContent = st.label;
    el.wheelGroup.appendChild(label);
  });

  // Jante
  const rim = document.createElementNS(SVG_NS, 'circle');
  rim.setAttribute('cx', CX); rim.setAttribute('cy', CY); rim.setAttribute('r', R);
  rim.setAttribute('fill', 'none');
  rim.setAttribute('stroke', 'rgba(226,232,240,.35)');
  rim.setAttribute('stroke-width', '5');
  el.wheelGroup.appendChild(rim);
}

/**
 * Fait tourner la roue jusqu'à la case imposée par le serveur.
 * L'animation est pilotée en rAF (et non en transition CSS) pour connaître
 * l'angle à chaque frame et cliquer à chaque case qui passe sous le pointeur.
 */
function spinWheel(targetSlot) {
  return new Promise((resolve) => {
    const n = CONFIG.wheel.length;
    const step = 360 / n;
    // Léger décalage dans la case pour ne pas tomber pile au centre à chaque fois.
    const jitter = (Math.random() - 0.5) * step * 0.55;
    const finalAngle = 360 * CONFIG.wheelTurns - (targetSlot * step + step / 2) + jitter;
    const t0 = performance.now();
    let lastUnder = -1;
    let lastTickAt = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      // On force la position finale : si l'animation a été gelée, la roue
      // doit quand même pointer sur la bonne case.
      el.wheelGroup.setAttribute('transform', `rotate(${finalAngle.toFixed(3)} 200 200)`);
      resolve();
    };
    // Filet de sécurité : si l'onglet passe en arrière-plan, le navigateur gèle
    // requestAnimationFrame et la promesse ne se résoudrait jamais — le joueur
    // resterait bloqué sur une roue figée sans bouton pour continuer.
    const guard = setTimeout(finish, CONFIG.wheelSpinMs + 600);

    (function frame(now) {
      const t = Math.min(1, (now - t0) / CONFIG.wheelSpinMs);
      const eased = 1 - Math.pow(1 - t, 4);       // décélération quartique
      const angle = finalAngle * eased;
      el.wheelGroup.setAttribute('transform', `rotate(${angle.toFixed(3)} 200 200)`);

      // Quelle case est sous le pointeur (midi) ?
      const under = Math.floor((((-angle % 360) + 360) % 360) / step);
      if (under !== lastUnder) {
        lastUnder = under;
        if (t < 1 && now - lastTickAt > CONFIG.wheelTickMinMs) {
          lastTickAt = now;
          tone({ freq: 1500, ms: 26, type: 'square', gain: 0.05 });
          el.pointer.classList.remove('knock');
          void el.pointer.offsetWidth;
          el.pointer.classList.add('knock');
        }
      }

      if (done) return;
      if (t < 1) requestAnimationFrame(frame);
      else finish();
    })(t0);
  });
}

/* --- Confettis (petit système de particules, aucun asset) ---------- */

function confettiBurst(colors, count = 150) {
  const c = el.confetti;
  c.width = c.clientWidth;
  c.height = c.clientHeight;
  const parts = Array.from({ length: count }, () => ({
    x: c.width / 2 + (Math.random() - 0.5) * c.width * 0.35,
    y: c.height * 0.45,
    vx: (Math.random() - 0.5) * 15,
    vy: -7 - Math.random() * 13,
    size: 4 + Math.random() * 7,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    color: colors[(Math.random() * colors.length) | 0],
    life: 1,
  }));

  let raf = 0;
  const start = performance.now();
  (function frame(now) {
    confettiCtx.clearRect(0, 0, c.width, c.height);
    let alive = false;
    for (const p of parts) {
      p.vy += 0.42;            // gravité
      p.vx *= 0.995;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      p.life = Math.max(0, 1 - (now - start) / 3200);
      if (p.life <= 0 || p.y > c.height + 30) continue;
      alive = true;
      confettiCtx.save();
      confettiCtx.translate(p.x, p.y);
      confettiCtx.rotate(p.rot);
      confettiCtx.globalAlpha = p.life;
      confettiCtx.fillStyle = p.color;
      confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      confettiCtx.restore();
    }
    if (alive) raf = requestAnimationFrame(frame);
    else confettiCtx.clearRect(0, 0, c.width, c.height);
  })(start);
  return () => cancelAnimationFrame(raf);
}

/* --- Enchaînement de l'écran ---------------------------------------- */

function showGamble(entry, fallbackTop, total) {
  pending = { id: entry.id, name: entry.name, spins: entry.spins, top: fallbackTop, total };

  el.gambleName.textContent = entry.name;
  el.gambleScore.textContent = entry.spins;
  el.bankAmount.textContent = `${entry.spins} tour${entry.spins > 1 ? 's' : ''}`;
  el.gambleVerdict.textContent = '';
  el.gambleDetail.textContent = 'Tu peux garder ton score… ou tout miser.';
  el.hubText.textContent = '🎲';
  el.wheelHub.classList.remove('win');
  el.wheelHub.style.color = '';
  el.gambleActions.hidden = false;
  el.btnAfterGamble.hidden = true;
  el.btnBank.disabled = false;
  el.btnGamble.disabled = false;
  el.btnGamble.classList.add('btn-pulse');
  el.wheelGroup.setAttribute('transform', 'rotate(0 200 200)');
  confettiCtx.clearRect(0, 0, el.confetti.width, el.confetti.height);

  showScreen('gamble');
}

async function playRoulette() {
  if (!pending) return;
  el.btnBank.disabled = true;
  el.btnGamble.disabled = true;
  el.btnGamble.classList.remove('btn-pulse');
  el.gambleDetail.textContent = 'La roue tourne…';

  let data;
  try {
    data = await api('/api/gamble', {
      method: 'POST',
      body: JSON.stringify({ id: pending.id }),
    });
  } catch (err) {
    console.error(err);
    // Serveur injoignable : on ne triche pas en tirant côté client, le score
    // encaissé reste acquis.
    el.gambleDetail.textContent = '⚠️ Roulette indisponible — ton score est conservé';
    el.gambleActions.hidden = true;
    el.btnAfterGamble.hidden = false;
    return;
  }

  el.gambleActions.hidden = true;
  await spinWheel(data.slot);
  revealOutcome(data);
}

function revealOutcome(data) {
  const { multiplier, score } = data;
  const st = styleOf(multiplier);
  const jackpot = multiplier >= 5;

  el.hubText.textContent = st.label;
  el.wheelHub.style.color = st.ink;
  el.wheelHub.classList.add('win');

  el.gambleScore.textContent = score;
  el.gambleVerdict.style.color = st.ink;
  el.gambleVerdict.classList.remove('in');
  void el.gambleVerdict.offsetWidth;
  el.gambleVerdict.classList.add('in');

  if (multiplier === 0) {
    el.gambleVerdict.textContent = 'PERDU';
    el.gambleDetail.textContent = `Tes ${pending.spins} tours partent en fumée 💨`;
    el.gambleCard.classList.remove('shake');
    void el.gambleCard.offsetWidth;
    el.gambleCard.classList.add('shake');
    tone({ freq: 420, to: 70, ms: 750, type: 'sawtooth', gain: 0.16 });
  } else if (jackpot) {
    el.gambleVerdict.textContent = multiplier >= 10 ? '🔥 JACKPOT 🔥' : 'ÉNORME !';
    el.gambleDetail.textContent = `${pending.spins} × ${multiplier} = ${score} points`;
    [0, 0.09, 0.18, 0.27, 0.42].forEach((d, i) =>
      tone({ freq: [523, 659, 784, 1046, 1318][i], ms: i === 4 ? 620 : 150, type: 'triangle', gain: 0.15, delay: d }));
    confettiBurst(['#facc15', '#fde047', '#fb923c', '#22d3ee', '#a855f7', '#f8fafc'], 220);
  } else {
    el.gambleVerdict.textContent = `GAGNÉ ×${multiplier}`;
    el.gambleDetail.textContent = `${pending.spins} × ${multiplier} = ${score} points`;
    tone({ freq: 523, ms: 140, type: 'triangle', gain: 0.14 });
    tone({ freq: 784, ms: 320, type: 'triangle', gain: 0.14, delay: 0.14 });
    confettiBurst(['#22d3ee', '#67e8f9', '#a855f7', '#f8fafc'], 110);
  }

  pending.result = data;
  el.btnAfterGamble.hidden = false;
}

function boardFromPending(data) {
  el.resultBanner.classList.remove('hidden');
  el.resultName.textContent = pending.name;
  el.resultSpins.textContent = data.score ?? pending.spins;
  const mult = data.multiplier;
  // Après un pari le total n'est plus un nombre de tours mais un score.
  el.resultUnit.textContent = mult == null ? (pending.spins > 1 ? 'tours' : 'tour') : 'points';
  el.resultRank.textContent =
    (data.rank === 1 ? '🥇 Meilleur score !' : `${data.rank}ᵉ place sur ${data.total} joueur${data.total > 1 ? 's' : ''}`) +
    (mult != null ? `   ·   ${pending.spins} tours ×${mult}` : '');
  renderBoard(data.top, data.total, pending.id);
  showScreen('board');
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), CONFIG.apiTimeoutMs);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function submitScore(name, spins, durationMs) {
  el.resultBanner.classList.remove('hidden');
  el.resultName.textContent = name;
  el.resultSpins.textContent = spins;
  el.resultUnit.textContent = spins > 1 ? 'tours' : 'tour';
  el.resultRank.textContent = 'Enregistrement…';
  el.boardBody.innerHTML =
    '<tr><td colspan="3" class="py-10 text-center"><div class="spinner"></div></td></tr>';
  showScreen('board');

  let data;
  try {
    data = await api('/api/score', {
      method: 'POST',
      body: JSON.stringify({ name, spins, durationMs }),
    });
  } catch (err) {
    console.error(err);
    el.resultRank.textContent = '⚠️ Score non enregistré (serveur injoignable)';
    loadBoard();
    return;
  }

  // Le score est déjà encaissé côté serveur : même si le joueur s'en va
  // maintenant, il garde ses tours. La roulette ne fait que le remplacer.
  if (spins > 0) {
    showGamble(data.entry, data.top, data.total);
    return;
  }

  // Zéro tour : rien à miser, on va droit au classement.
  el.resultRank.textContent =
    `${data.rank}ᵉ place sur ${data.total} joueur${data.total > 1 ? 's' : ''}`;
  renderBoard(data.top, data.total, data.entry.id);
}

async function loadBoard(highlightId = null) {
  try {
    const data = await api('/api/leaderboard?limit=10');
    renderBoard(data.top, data.total, highlightId);
  } catch (err) {
    el.boardBody.innerHTML =
      '<tr><td colspan="3" class="py-10 text-center text-rose-400">Classement indisponible</td></tr>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const MEDALS = ['🥇', '🥈', '🥉'];

function renderBoard(top, total, highlightId) {
  el.boardTotal.textContent = total ? `${total} participation${total > 1 ? 's' : ''}` : '';

  if (!top || !top.length) {
    el.boardBody.innerHTML =
      '<tr><td colspan="3" class="py-10 text-center text-slate-500">Personne n\'a encore joué. À toi l\'honneur&nbsp;!</td></tr>';
    return;
  }

  el.boardBody.innerHTML = top.map((s) => {
    const score = Number.isFinite(s.score) ? s.score : s.spins;
    // On garde le détail « tours × multiplicateur » : le classement reste
    // lisible et on voit qui a osé la roulette.
    const detail = s.multiplier == null
      ? ''
      : `<span class="block text-[11px] font-bold ${s.multiplier === 0 ? 'text-rose-400' : 'text-amber-300'}">
           ${s.spins} tour${s.spins > 1 ? 's' : ''} ×${s.multiplier}
         </span>`;
    return `
    <tr class="${s.id === highlightId ? 'me' : ''}">
      <td class="py-3 text-lg font-black text-slate-400 align-top">${MEDALS[s.rank - 1] || s.rank}</td>
      <td class="py-3 font-bold text-lg truncate">${escapeHtml(s.name)}${detail}</td>
      <td class="py-3 text-right text-2xl font-black tabular-nums text-cyan-300 align-top">${score}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/*  ÉVÉNEMENTS                                                         */
/* ------------------------------------------------------------------ */

el.homeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.pseudo.value.trim().replace(/\s+/g, ' ').slice(0, 20);
  if (name.length < 2) {
    el.homeError.textContent = 'Entre un pseudo (2 caractères minimum).';
    el.pseudo.focus();
    return;
  }
  el.homeError.textContent = '';
  beep(740, 90, 'sine', 0.1); // débloque aussi l'AudioContext (geste utilisateur)
  startRound(name);
});

el.btnSeeBoard.addEventListener('click', () => {
  el.resultBanner.classList.add('hidden');
  el.boardBody.innerHTML =
    '<tr><td colspan="3" class="py-10 text-center"><div class="spinner"></div></td></tr>';
  showScreen('board');
  loadBoard();
});

el.btnStop.addEventListener('click', () => {
  if (state.phase === 'playing') endRound('manual');
  else if (state.phase === 'countdown') endRound('abort');
});

el.btnNewPlayer.addEventListener('click', backToHome);

el.btnGamble.addEventListener('click', playRoulette);

el.btnBank.addEventListener('click', () => {
  if (!pending) return backToHome();
  tone({ freq: 880, ms: 110, type: 'sine', gain: 0.12 });
  boardFromPending({ top: pending.top, total: pending.total, rank: rankOf(pending.top, pending.id), score: pending.spins, multiplier: null });
});

el.btnAfterGamble.addEventListener('click', () => {
  if (!pending) return backToHome();
  const r = pending.result;
  boardFromPending(r || { top: pending.top, total: pending.total, rank: rankOf(pending.top, pending.id), score: pending.spins, multiplier: null });
});

/** Rang du joueur dans un top déjà trié (0 si hors du top affiché). */
function rankOf(top, id) {
  const row = (top || []).find((s) => s.id === id);
  return row ? row.rank : (pending?.total ?? 0);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') {
    state.debug = !state.debug;
    el.debug.classList.toggle('on', state.debug);
  }
  if (e.key === 'Escape' && (state.phase === 'playing' || state.phase === 'countdown')) {
    endRound('abort');
  }
});

// Onglet en arrière-plan = plus aucune détection (le navigateur gèle la
// boucle de rendu) : on arrête proprement plutôt que de laisser tourner
// quelqu'un dans le vide.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.phase === 'playing') endRound('manual');
});

/* ------------------------------------------------------------------ */
/*  DÉMARRAGE                                                          */
/* ------------------------------------------------------------------ */

(async function boot() {
  // Config serveur (durée de manche pilotable par variable d'environnement)
  try {
    const cfg = await api('/api/config');
    CONFIG.roundDurationMs = cfg.roundDurationMs || CONFIG.roundDurationMs;
    CONFIG.countdownSeconds = cfg.countdownSeconds ?? CONFIG.countdownSeconds;
    // Le serveur est la seule source de vérité sur les probabilités.
    if (Array.isArray(cfg.wheel) && cfg.wheel.length >= 4) CONFIG.wheel = cfg.wheel;
  } catch { /* on garde les valeurs par défaut */ }

  buildWheel();
  el.homeDuration.textContent = `${Math.round(CONFIG.roundDurationMs / 1000)} secondes`;
  el.timeLeft.textContent = (CONFIG.roundDurationMs / 1000).toFixed(1);
  el.pseudo.focus();

  // Préchargement du modèle en tâche de fond : le bouton « Commencer »
  // devient instantané pour le joueur suivant.
  el.btnStart.disabled = true;
  try {
    await loadDetector();
    el.engineStatus.textContent = '✅ Moteur de détection prêt — webcam requise';
    el.engineStatus.className = 'mt-6 text-xs text-emerald-400';
  } catch (err) {
    console.error(err);
    el.engineStatus.textContent = `⚠️ Moteur indisponible : ${err.message}`;
    el.engineStatus.className = 'mt-6 text-xs text-rose-400';
  } finally {
    el.btnStart.disabled = false;
  }

  // Mode démo : « /?demo=9 » saute directement à la roulette avec 9 tours.
  // Pratique pour régler l'animation ou montrer la borne sans tourner 9 fois.
  const demo = Number(new URLSearchParams(location.search).get('demo'));
  if (Number.isInteger(demo) && demo > 0 && demo <= 100) {
    submitScore('Démo', demo, CONFIG.roundDurationMs);
  }
})();
