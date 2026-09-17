/* =====================================================================
 *  SPIN CHALLENGE — écran mur (classement temps réel)
 *  ---------------------------------------------------------------
 *  Conçu pour un mur de 1000 × 5000 px (5 écrans empilés), mais tout est
 *  proportionnel : la page reste correcte sur n'importe quel format.
 * ===================================================================== */

const CONFIG = {
  // Hauteur minimale confortable d'une ligne : c'est elle qui plafonne le
  // nombre de joueurs affichés (~25 sur le mur, ~5 sur un laptop).
  minRowPx: 130,
  // …et hauteur maximale, sinon avec 2 joueurs sur un mur de 5000 px on
  // obtiendrait des lignes de 2 mètres de haut.
  maxRowPx: 400,
  maxRows: 25,
  minRows: 3,
  // Repli si le flux temps réel tombe.
  pollMs: 4000,
  reconnectMs: 3000,
};

const $ = (s) => document.querySelector(s);
const el = {
  wall: $('#wall'),
  rows: $('#rows'),
  empty: $('#empty'),
  sub: $('#sub'),
  dot: $('#dot'),
  status: $('#status'),
};

/* ------------------------------------------------------------------ */
/*  Dimensionnement                                                    */
/* ------------------------------------------------------------------ */

let rowCount = 10;
let rowH = 130;
let gap = 18;
let offsetY = 0;
let lastCount = 0;
let lastData = { top: [], total: 0 };

/**
 * `--row` pilote la hauteur des lignes, `--u` la typographie.
 *
 * Les deux sont distincts parce qu'un mur très haut et étroit donne des
 * lignes de 300 px de haut dans seulement 1000 px de large : caler les
 * polices sur la hauteur écrasait la colonne du pseudo. `--u` est bornée
 * par la largeur, ce qui garde des proportions lisibles à tout format.
 */
function setRow(px) {
  const root = document.documentElement.style;
  root.setProperty('--row', `${px.toFixed(2)}px`);
  // Bornée par la largeur ET par la hauteur : sans la borne en hauteur, un
  // écran large et court (un laptop) se retrouvait avec un en-tête géant qui
  // ne laissait la place qu'à trois lignes.
  const u = Math.min(px, window.innerWidth * 0.26, window.innerHeight * 0.18);
  root.setProperty('--u', `${u.toFixed(2)}px`);
}

/**
 * Décide combien de lignes afficher et à quelle taille.
 *
 * Le point clé : la taille dépend du **nombre réel de joueurs**. Sur un mur de
 * 5000 px avec 8 joueurs, des lignes calibrées pour 25 laisseraient les deux
 * tiers de l'écran vides. Ici les lignes grandissent pour remplir la hauteur,
 * dans la limite de `maxRowPx`.
 *
 * L'en-tête et le pied étant eux-mêmes dimensionnés à partir de `--row`, on
 * procède en deux passes : une estimation, puis une mesure réelle du bandeau.
 */
function layout(count = lastCount) {
  lastCount = count;
  const wanted = Math.max(1, count);

  // Le calcul est circulaire : la taille des lignes dépend de la place libre,
  // qui dépend de l'en-tête, qui est lui-même dimensionné d'après les lignes.
  // Plutôt que d'additionner marges et paddings à la main (ce qui laissait la
  // dernière ligne passer sous le pied de page), on MESURE la hauteur réelle
  // que le flex accorde au conteneur, et on itère jusqu'à convergence.
  for (let pass = 0; pass < 4; pass++) {
    const usable = el.rows.clientHeight;
    if (usable < 40) break;

    const fit = Math.max(CONFIG.minRows, Math.floor(usable / CONFIG.minRowPx));
    const n = Math.max(CONFIG.minRows, Math.min(CONFIG.maxRows, fit, Math.max(wanted, CONFIG.minRows)));
    const h = Math.min(CONFIG.maxRowPx, usable / (n * 1.14));

    const stable = Math.abs(h - rowH) < 0.5 && n === rowCount;
    rowCount = n;
    rowH = h;
    gap = h * 0.14;
    setRow(h);
    if (stable) break;
  }

  // Si les lignes butent sur maxRowPx il reste de la place : on centre le
  // bloc plutôt que de le laisser collé en haut.
  const visible = Math.min(Math.max(wanted, 1), rowCount);
  const blockH = visible * rowH + Math.max(0, visible - 1) * gap;
  offsetY = Math.max(0, (el.rows.clientHeight - blockH) / 2);

  place();
}

const yOf = (i) => offsetY + i * (rowH + gap);

/** Positionne chaque ligne verticalement (transform = animable, donc fluide). */
function place() {
  for (const node of el.rows.children) {
    if (!node.classList.contains('row')) continue;
    const y = yOf(Number(node.dataset.index)).toFixed(2);
    node.style.setProperty('--y', `${y}px`);
    node.style.transform = `translateY(${y}px)`;
  }
}

window.addEventListener('resize', () => render(lastData));

/* ------------------------------------------------------------------ */
/*  Rendu                                                              */
/* ------------------------------------------------------------------ */

const MEDALS = ['🥇', '🥈', '🥉'];
const nodes = new Map(); // id → élément, pour animer les déplacements

const esc = (s) => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function buildRow(entry) {
  const node = document.createElement('div');
  node.className = 'row enter';
  node.dataset.id = entry.id;
  node.innerHTML = `
    <div class="pos"></div>
    <div class="who"><div class="name"></div><div class="detail"></div></div>
    <div class="pts"><span class="v"></span><small>PTS</small></div>`;
  return node;
}

function fillRow(node, entry) {
  const score = Number.isFinite(entry.score) ? entry.score : entry.spins;
  node.querySelector('.pos').textContent = MEDALS[entry.rank - 1] || entry.rank;
  const nameEl = node.querySelector('.name');
  nameEl.textContent = entry.name;
  // Un pseudo de 15 lettres ne tient pas dans la colonne à taille pleine.
  // On le rétrécit proportionnellement plutôt que de le couper à « Marie-C… ».
  node.style.setProperty('--ns', Math.min(1, 9.5 / Math.max(1, entry.name.length)).toFixed(3));
  node.querySelector('.pts .v').textContent = score;

  const detail = node.querySelector('.detail');
  if (entry.multiplier == null) {
    detail.textContent = `${entry.spins} tour${entry.spins > 1 ? 's' : ''} · encaissé`;
    detail.className = 'detail';
  } else if (entry.multiplier === 0) {
    detail.textContent = `${entry.spins} tour${entry.spins > 1 ? 's' : ''} · roulette perdue`;
    detail.className = 'detail bust';
  } else {
    detail.textContent = `${entry.spins} tour${entry.spins > 1 ? 's' : ''} × ${entry.multiplier}`;
    detail.className = 'detail win';
  }

  node.classList.toggle('p1', entry.rank === 1);
  node.classList.toggle('p2', entry.rank === 2);
  node.classList.toggle('p3', entry.rank === 3);
}

function render(data) {
  lastData = data;
  // La taille des lignes dépend du nombre de joueurs : on relaie l'info
  // avant de dessiner, sinon le mur resterait à moitié vide.
  layout((data.top || []).length);
  const top = (data.top || []).slice(0, rowCount);

  el.empty.style.display = top.length ? 'none' : 'grid';
  el.sub.textContent = data.total
    ? `${data.total} participation${data.total > 1 ? 's' : ''}`
    : 'En attente des premiers joueurs…';

  const seen = new Set();

  top.forEach((entry, i) => {
    seen.add(entry.id);
    let node = nodes.get(entry.id);
    const isNew = !node;

    if (isNew) {
      node = buildRow(entry);
      nodes.set(entry.id, node);
      el.rows.appendChild(node);
    }
    node.dataset.index = i;
    fillRow(node, entry);

    if (isNew) {
      // Position de départ posée avant de retirer `.enter`, sinon la ligne
      // apparaîtrait en haut puis glisserait : on veut qu'elle surgisse
      // directement à sa place.
      node.style.setProperty('--y', `${yOf(i).toFixed(2)}px`);
      node.style.transform = `translateY(${yOf(i).toFixed(2)}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('enter')));
    }
  });

  // Les joueurs sortis du top disparaissent.
  for (const [id, node] of nodes) {
    if (seen.has(id)) continue;
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 450);
    nodes.delete(id);
  }

  place();

  // Mise en avant de la manche qui vient de se terminer.
  const hl = data.highlight;
  if (hl?.id && nodes.has(hl.id)) {
    const node = nodes.get(hl.id);
    const cls = hl.kind === 'gamble' && hl.multiplier >= 5 ? 'jackpot' : 'flash';
    node.classList.remove('flash', 'jackpot');
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), 2800);
  }
}

/* ------------------------------------------------------------------ */
/*  Flux temps réel                                                    */
/* ------------------------------------------------------------------ */

function setStatus(live, text) {
  el.dot.classList.toggle('off', !live);
  el.status.textContent = text;
}

let source = null;
let pollTimer = 0;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/api/leaderboard?limit=${CONFIG.maxRows}`);
      render(await r.json());
      setStatus(true, 'Mise à jour périodique');
    } catch {
      setStatus(false, 'Serveur injoignable');
    }
  }, CONFIG.pollMs);
}

function connect() {
  source?.close();
  setStatus(false, 'Connexion…');

  source = new EventSource('/api/stream');

  source.onopen = () => {
    clearInterval(pollTimer);       // le flux reprend la main sur le sondage
    setStatus(true, 'En direct');
  };

  source.onmessage = (ev) => {
    try { render(JSON.parse(ev.data)); } catch (err) { console.error(err); }
  };

  source.onerror = () => {
    setStatus(false, 'Reconnexion…');
    source.close();
    // Sondage en attendant : l'écran ne doit jamais rester figé devant le public.
    startPolling();
    setTimeout(connect, CONFIG.reconnectMs);
  };
}

/* ------------------------------------------------------------------ */

layout(0);
connect();

// Un mur d'écrans tourne des heures sans personne : on revérifie la mise en
// page de temps en temps (résolution qui change, écran qui se réveille).
setInterval(() => render(lastData), 30_000);
