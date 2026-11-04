/* =====================================================================
 *  SPIN CHALLENGE — mur d'écrans
 *  ---------------------------------------------------------------
 *  Une tour de 5 moniteurs empilés, vus par le système comme 5
 *  affichages distincts, avec UNE seule fenêtre étirée par-dessus.
 *  Les pixels sont continus, mais les cadres des moniteurs coupent
 *  physiquement l'image : il ne faut jamais qu'une ligne tombe à
 *  cheval sur une jointure.
 * ===================================================================== */

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) && Number.isFinite(+params.get(k)) ? +params.get(k) : d);

const CONFIG = {
  /* Combien de lignes par écran, du haut vers le bas.
     Le 1er écran est réservé au vainqueur, sous le logo.
     Réglable sans toucher au code :  /board?rows=1,3,3,3,3          */
  rowsPerPanel: (params.get('rows') || '1,3,3,3,3')
    .split(',').map((n) => Math.max(0, Math.min(8, parseInt(n, 10) || 0))),

  /* Hauteur d'UN moniteur, en pixels. Déduite de screen.height, qui est
     fiable quand les 5 écrans sont identiques. Forçable : ?h=1024       */
  screenH: num('h', 0),

  /* Position du haut du viewport sur le bureau virtuel. Déduite de
     window.screenY + la hauteur du chrome. Forçable : ?top=120          */
  viewportTop: num('top', -1),

  minRowPx: 70,
  maxRowPx: 460,
  gapRatio: 0.14,        // interligne, en proportion de la hauteur de ligne
  headerMinPx: 150,      // en dessous, le logo devient illisible

  pollMs: 4000,
  reconnectMs: 3000,
};

const $ = (s) => document.querySelector(s);
const el = {
  wall: $('#wall'), rows: $('#rows'), empty: $('#empty'), guides: $('#guides'),
  header: document.querySelector('header'), logo: $('#logo'),
  sub: $('#sub'), dot: $('#dot'), status: $('#status'),
};

/* ------------------------------------------------------------------ */
/*  Géométrie — où sont les jointures entre les écrans ?               */
/* ------------------------------------------------------------------ */

/**
 * Les 5 moniteurs occupent, sur le bureau virtuel, les bandes
 * [0,S], [S,2S], … La fenêtre commence plus bas que 0 (barre de titre,
 * onglets, barre d'adresse), d'où le décalage `viewportTop`.
 *
 * Jointure k, en coordonnées du viewport :   k × S − viewportTop
 *
 * screen.height donne S tant que les écrans sont identiques — c'est le
 * cas ici. window.screenY donne la position de la fenêtre, et
 * outerHeight − innerHeight la hauteur du chrome du navigateur.
 */
function panelEdges() {
  const V = window.innerHeight;
  const S = CONFIG.screenH || window.screen?.height || V;
  const top = CONFIG.viewportTop >= 0
    ? CONFIG.viewportTop
    : (window.screenY || 0) + Math.max(0, window.outerHeight - window.innerHeight);

  const edges = [0];
  for (let k = 1; k < CONFIG.rowsPerPanel.length; k++) {
    const y = Math.round(k * S - top);
    // Une jointure hors du viewport ne découpe rien : on l'ignore, et le
    // panneau correspondant se retrouve simplement vide.
    edges.push(Math.max(0, Math.min(V, y)));
  }
  edges.push(V);

  const panels = [];
  for (let i = 0; i < CONFIG.rowsPerPanel.length; i++) {
    panels.push({ top: edges[i], height: Math.max(0, edges[i + 1] - edges[i]) });
  }
  return { panels, S, top, V };
}

/* ------------------------------------------------------------------ */
/*  Mise en page                                                       */
/* ------------------------------------------------------------------ */

let rowH = 120;
let gap = 17;
let rowY = [];       // ordonnée de chaque rang, index = place au classement
let slotCount = 0;
let lastData = { top: [], total: 0 };

function setVars(px) {
  const root = document.documentElement.style;
  root.setProperty('--row', `${px.toFixed(2)}px`);
  // Bornée par la largeur : le mur est très haut et très étroit, caler la
  // typo sur la seule hauteur des lignes écrasait la colonne du pseudo.
  root.setProperty('--u', `${Math.min(px, window.innerWidth * 0.26).toFixed(2)}px`);
}

/** Hauteur de ligne tenant dans un panneau de `h` px accueillant `n` lignes. */
const fit = (h, n) => (n <= 0 ? Infinity : h / (n + CONFIG.gapRatio * (n - 1)));

/**
 * Un panneau n'est retenu que s'il peut réellement accueillir ses lignes.
 * Sans ce garde-fou, un panneau tronqué (fenêtre plus courte que prévu, ou
 * ?h mal réglé) imposerait sa hauteur minuscule à TOUTES les lignes du mur.
 */
const usable = (panel, n) => panel.height >= n * CONFIG.minRowPx;

function layout() {
  const { panels, V } = panelEdges();
  const perPanel = CONFIG.rowsPerPanel;
  const pad = () => rowH * 0.12;   // marge intérieure d'un panneau

  // 1) Hauteur de ligne imposée par les panneaux SANS en-tête.
  let h = CONFIG.maxRowPx;
  for (let i = 1; i < panels.length; i++) {
    if (!perPanel[i] || !usable(panels[i], perPanel[i])) continue;
    h = Math.min(h, fit(panels[i].height * 0.88, perPanel[i]));
  }
  h = Math.min(h, window.innerWidth * 0.3);

  // 2) Le 1er panneau doit loger l'en-tête PLUS ses lignes. S'il est trop
  //    juste, c'est la hauteur de ligne qui cède — pas l'en-tête, sinon le
  //    logo devient illisible.
  const p0 = panels[0];
  if (usable(p0, perPanel[0]) && perPanel[0] > 0) {
    const need = (hh) => perPanel[0] * hh + (perPanel[0] - 1) * hh * CONFIG.gapRatio;
    let guard = 0;
    while (h > CONFIG.minRowPx && guard++ < 40) {
      if (p0.height - need(h) - 2 * (h * 0.12) >= CONFIG.headerMinPx) break;
      h *= 0.95;
    }
  }
  rowH = Math.max(CONFIG.minRowPx, h);
  gap = rowH * CONFIG.gapRatio;
  setVars(rowH);

  // 3) En-tête : centré dans la place qui reste en haut du 1er écran.
  const blockH0 = perPanel[0] > 0
    ? perPanel[0] * rowH + (perPanel[0] - 1) * gap
    : 0;
  // La couronne du 1er dépasse au-dessus de sa carte : on lui réserve la
  // place, sinon elle mordrait sur le compteur de participations.
  const crownRoom = perPanel[0] > 0 ? rowH * 0.34 : 0;
  const headerBand = Math.max(0, p0.height - blockH0 - 2 * pad() - crownRoom);
  // Bornes en PIXELS : `max-width` en pourcentage sur un parent en
  // `width:fit-content` est circulaire, et le navigateur tranche en
  // écrasant le logo.
  el.logo.style.maxHeight = `${Math.max(70, headerBand * 0.7).toFixed(0)}px`;
  el.logo.style.maxWidth = `${(window.innerWidth * 0.68).toFixed(0)}px`;
  el.header.style.top = '0px';
  el.header.style.height = `${headerBand.toFixed(0)}px`;
  el.header.style.display = 'flex';
  el.header.style.flexDirection = 'column';
  el.header.style.alignItems = 'center';
  el.header.style.justifyContent = 'center';

  // 4) Ordonnée de chaque rang : les lignes d'un panneau sont centrées
  //    dans ce qu'il lui reste, donc jamais à cheval sur une jointure.
  rowY = [];
  for (let i = 0; i < panels.length; i++) {
    const n = perPanel[i] || 0;
    if (!n || !usable(panels[i], n)) continue;
    const blockH = n * rowH + (n - 1) * gap;
    const free = panels[i].height - blockH;
    // Le 1er panneau pousse ses lignes en bas, sous l'en-tête ; les autres
    // les centrent.
    const start = panels[i].top + (i === 0 ? Math.max(pad(), free - pad()) : free / 2);
    for (let k = 0; k < n; k++) rowY.push(start + k * (rowH + gap));
  }
  slotCount = rowY.length;

  // Marge latérale : l'ombre portée du podium doit rester dans l'écran.
  const side = Math.max(14, rowH * 0.16);
  el.rows.style.padding = `0 ${side.toFixed(0)}px`;
  for (const node of el.rows.children) {
    node.style.left = `${side.toFixed(0)}px`;
    node.style.right = `${side.toFixed(0)}px`;
  }

  el.empty.style.top = `${(panels[0].top + p0.height * 0.55).toFixed(0)}px`;
  drawGuides();
  place();
}

function drawGuides() {
  if (!params.has('guides')) return;
  const g = panelEdges();
  el.guides.classList.add('on');
  const auto = !CONFIG.screenH && CONFIG.viewportTop < 0;
  el.guides.innerHTML =
    `<div class="edge" style="top:0"><span>` +
    `${auto ? 'auto' : 'forcé'} · écran ${Math.round(g.S)}px · haut viewport ${Math.round(g.top)}px ` +
    `· lignes ${CONFIG.rowsPerPanel.join('/')}</span></div>` +
    g.panels.slice(1).map((p, i) =>
      `<div class="edge" style="top:${p.top}px"><span>jointure ${i + 1}\u2192${i + 2} · y=${p.top}px</span></div>`
    ).join('');
}

const yOf = (i) => (i < rowY.length ? rowY[i] : V_FALLBACK());
const V_FALLBACK = () => window.innerHeight + 200;   // hors écran

function place() {
  for (const node of el.rows.children) {
    if (!node.classList.contains('row')) continue;
    const y = yOf(Number(node.dataset.index)).toFixed(2);
    node.style.transform = `translateY(${y}px)`;
  }
}

/**
 * La mise en page dépend de la taille ET de la position de la fenêtre (une
 * fenêtre déplacée de 40 px décale toutes les jointures). Or :
 *  - déplacer une fenêtre n'émet aucun événement ;
 *  - l'étirer sur 5 écrans n'émet pas toujours `resize` (constaté en test :
 *    viewport passé de 900 à 5000 px sans un seul événement, mur figé sur
 *    une ligne).
 * On surveille donc directement la géométrie, et on ne recalcule que si
 * elle a changé.
 */
let geoKey = '';
const geometryKey = () => [
  window.innerWidth, window.innerHeight, window.outerHeight,
  window.screenY, window.screen?.height,
].join('|');
function relayoutIfNeeded(force = false) {
  const k = geometryKey();
  if (!force && k === geoKey) return;
  geoKey = k;
  layout();
  render(lastData);
}
window.addEventListener('resize', () => relayoutIfNeeded());
if ('ResizeObserver' in window) new ResizeObserver(() => relayoutIfNeeded()).observe(el.wall);

/* ------------------------------------------------------------------ */
/*  Rendu                                                              */
/* ------------------------------------------------------------------ */

const nodes = new Map();   // id → élément, pour animer les déplacements

function buildRow(entry) {
  const node = document.createElement('div');
  node.className = 'row enter';
  node.dataset.id = entry.id;
  node.innerHTML = `
    <div class="pos"></div>
    <div class="who"><div class="name"></div><div class="detail"></div></div>
    <div class="pts"><span class="v"></span><small>PTS</small></div>
    <svg class="crown" viewBox="0 0 64 54" aria-hidden="true">
      <path d="M7 45 L3 14 L19 28 L32 5 L45 28 L61 14 L57 45 Z"
            fill="#FFF540" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
      <rect x="6" y="41" width="52" height="9" rx="3"
            fill="#FFF540" stroke="#fff" stroke-width="4"/>
      <circle cx="32" cy="29" r="3.6" fill="#FF69EB"/>
      <circle cx="18" cy="35" r="2.8" fill="#5EFC8D"/>
      <circle cx="46" cy="35" r="2.8" fill="#5EFC8D"/>
    </svg>`;
  return node;
}

function fillRow(node, entry) {
  const score = Number.isFinite(entry.score) ? entry.score : entry.spins;
  node.querySelector('.pos').textContent = entry.rank;

  const nameEl = node.querySelector('.name');
  nameEl.textContent = entry.name;
  // Un pseudo de 15 lettres ne tient pas à taille pleine : on le rétrécit
  // plutôt que de le couper à « Marie-C… ».
  node.style.setProperty('--ns', Math.min(1, 9.5 / Math.max(1, entry.name.length)).toFixed(3));
  node.querySelector('.pts .v').textContent = score;

  const detail = node.querySelector('.detail');
  const t = `${entry.spins} tour${entry.spins > 1 ? 's' : ''}`;
  if (entry.multiplier == null) {
    detail.textContent = `${t} · encaissé`; detail.className = 'detail';
  } else if (entry.multiplier === 0) {
    detail.textContent = `${t} · roulette perdue`; detail.className = 'detail bust';
  } else {
    detail.textContent = `${t} × ${entry.multiplier}`; detail.className = 'detail win';
  }

  node.classList.toggle('p1', entry.rank === 1);
  node.classList.toggle('p2', entry.rank === 2);
  node.classList.toggle('p3', entry.rank === 3);
}

function render(data) {
  lastData = data;
  const top = (data.top || []).slice(0, slotCount);

  el.empty.style.display = top.length ? 'none' : 'block';
  el.sub.textContent = data.total
    ? `${data.total} participation${data.total > 1 ? 's' : ''}`
    : 'En attente des premiers joueurs…';

  const side = parseFloat(el.rows.style.paddingLeft) || 16;
  const seen = new Set();

  top.forEach((entry, i) => {
    seen.add(entry.id);
    let node = nodes.get(entry.id);
    const isNew = !node;
    if (isNew) {
      node = buildRow(entry);
      node.style.left = `${side}px`;
      node.style.right = `${side}px`;
      nodes.set(entry.id, node);
      el.rows.appendChild(node);
    }
    node.dataset.index = i;
    fillRow(node, entry);
    if (isNew) {
      // Position posée AVANT de retirer `.enter` : la ligne doit surgir à
      // sa place, pas glisser depuis le haut de l'écran.
      node.style.transform = `translateY(${yOf(i).toFixed(2)}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('enter')));
    }
  });

  for (const [id, node] of nodes) {
    if (seen.has(id)) continue;
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 450);
    nodes.delete(id);
  }

  place();

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
  el.status.textContent = live ? '' : text;   // en direct = rien à dire
}

let source = null;
let pollTimer = 0;

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      render(await (await fetch(`/api/leaderboard?limit=30`)).json());
      setStatus(true, '');
    } catch { setStatus(false, 'serveur injoignable'); }
  }, CONFIG.pollMs);
}

function connect() {
  source?.close();
  setStatus(false, 'connexion…');
  source = new EventSource('/api/stream');
  source.onopen = () => { clearInterval(pollTimer); setStatus(true, ''); };
  source.onmessage = (ev) => {
    try { render(JSON.parse(ev.data)); } catch (err) { console.error(err); }
  };
  source.onerror = () => {
    setStatus(false, 'reconnexion…');
    source.close();
    // L'écran ne doit jamais rester figé devant le public.
    startPolling();
    setTimeout(connect, CONFIG.reconnectMs);
  };
}

/* ------------------------------------------------------------------ */

// Le logo influe sur la place restante : on attend qu'il soit mesurable.
el.logo.addEventListener('load', () => relayoutIfNeeded(true));
relayoutIfNeeded(true);
connect();

// Filet de sécurité bon marché : une comparaison de 5 nombres par seconde,
// un recalcul seulement si la fenêtre a bougé ou changé de taille.
setInterval(() => relayoutIfNeeded(), 1000);
