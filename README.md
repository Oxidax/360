# 🌀 Spin Challenge

Borne événementielle locale : une personne se place devant la webcam et fait
un maximum de **tours complets à 360°** sur elle-même en 15 secondes.
L'application compte les tours automatiquement, propose de **miser son score à
la roulette**, et tient un classement.

Tout tourne **en local** : la détection de pose s'exécute dans le navigateur,
les scores sont stockés dans un simple fichier JSON. Aucune image ne quitte la
machine, aucune connexion internet n'est nécessaire une fois installé.

---

## 1. Installation

```bash
npm install
```

C'est tout : le modèle de détection (`public/models/pose_landmarker_lite.task`,
5,5 Mo) est déjà présent dans le dépôt, et le runtime MediaPipe est servi depuis
`node_modules`. **Aucun CDN n'est appelé au runtime** — sauf Tailwind (voir §6).

## 2. Lancement

```bash
npm start
```

Puis ouvre **http://localhost:3000** dans Chrome.

> ⚠️ La webcam n'est accessible qu'en contexte sécurisé. `http://localhost`
> en fait partie — mais **pas** `http://192.168.x.x`. Pour utiliser la borne,
> reste sur `localhost`.

Durée de manche et décompte sans toucher au code :

```bash
ROUND_MS=30000 COUNTDOWN=3 npm start
```

Pendant le dev, `npm run dev` relance le serveur à chaque modification.

## 2 bis. Vérifier l'algorithme

```bash
npm test
```

Rejoue 25 scénarios sur une « personne virtuelle » (tours lents/rapides, bruit
de mesure, webcam à 15 fps, sortie du cadre, oscillations…) et affiche le taux
de faux positifs. **À relancer après chaque changement de réglage** dans
`CONFIG` : c'est le filet de sécurité qui dit si tu as cassé quelque chose.

---

## 3. Structure du projet

```
V1/
├── server.js              # Express : statique + API classement
├── render.yaml            # déploiement en ligne (§9)
├── leaderboard.json       # base de données (créée automatiquement)
├── package.json
├── test/
│   └── spin.test.mjs      # banc d'essai de l'algorithme (npm test)
└── public/
    ├── index.html         # les 4 écrans (SPA) + styles
    ├── app.js             # MediaPipe, comptage, roulette, chrono, API
    └── models/
        └── pose_landmarker_lite.task
```

## 4. API locale

| Méthode  | Route               | Description                                          |
| -------- | ------------------- | ---------------------------------------------------- |
| `GET`    | `/api/config`       | Durée de manche et décompte (lus par le front)       |
| `GET`    | `/api/leaderboard`  | Top N (`?limit=10`)                                  |
| `POST`   | `/api/score`        | `{ name, spins, durationMs }` → renvoie le rang      |
| `POST`   | `/api/gamble`       | `{ id }` → tire la roulette, renvoie le multiplicateur |
| `DELETE` | `/api/leaderboard`  | Remise à zéro (borne uniquement, avec sauvegarde)    |

Réinitialiser le classement entre deux événements :

```bash
npm run reset
```

L'ancien classement est archivé dans `leaderboard.backup-<timestamp>.json`.

---

## 4 bis. La roulette

Après chaque manche, le joueur choisit : **encaisser** son score, ou **tout
miser** sur une roue qui peut le multiplier — ou le réduire à zéro.

### La roue *est* la table de probabilités

20 cases, tirage **uniforme** sur les cases. Il n'y a donc aucun écart entre ce
que le joueur voit et ses vraies chances — pas de roue truquée qui « ralentit »
juste avant le jackpot.

| Case  | Nombre de cases | Probabilité |
| ----- | --------------- | ----------- |
| ✕0    | 10 / 20         | 50 %        |
| ×2    | 5 / 20          | 25 %        |
| ×3    | 3 / 20          | 15 %        |
| ×5    | 1 / 20          | 5 %         |
| ×10   | 1 / 20          | 5 %         |

**Espérance = 1,70.** Miser est donc statistiquement gagnant : c'est assumé, on
veut que les gens tentent — c'est là qu'est le plaisir. Les cases alternent
perte / gain et les gros lots sont encadrés de ✕0, ce qui produit naturellement
des « à une case près ! ».

Pour changer la roue sans toucher au code :

```bash
WHEEL=0,0,2,0,3,0,2,0,0,5,0,2,0,0,3,0,10,0,2,0 npm start
```

Pour en faire un **vrai dilemme** (espérance < 1, encaisser devient le choix
raisonnable), ajoute des ✕0 — mais attends-toi à beaucoup de joueurs déçus, ce
qui n'est pas forcément ce que tu veux sur un stand.

### Le tirage est fait par le serveur

Volontairement : sinon n'importe qui ouvre la console du navigateur et force son
résultat, ou recharge la page jusqu'à tomber sur le ×10. Le serveur refuse aussi
de rejouer une manche déjà jouée (`409`) et une manche de plus de 10 minutes
(`410`).

Le score est **enregistré avant** le pari : si le joueur s'en va ou si le
serveur tombe pendant la roulette, ses tours restent acquis.

### Classement

Le classement trie sur le **score final** (tours × multiplicateur) et affiche le
détail (`12 tours ×3`). À score égal, **celui qui a réellement le plus tourné
passe devant** : le mérite départage la chance. Les deux valeurs sont stockées
séparément dans `leaderboard.json` (`spins` et `score`), donc tu peux toujours
refaire un classement « tours réels » après coup si la chance a trop pesé.

### Tester la roulette sans tourner

```
http://localhost:3000/?demo=9
```

Va directement à l'écran roulette avec 9 tours en poche. Pratique pour régler
l'animation ou faire une démo.

---

## 5. Comment le comptage fonctionne

MediaPipe Pose renvoie des `worldLandmarks` : des points 3D **en mètres**.
On projette le segment *épaule droite → épaule gauche* sur le plan horizontal
(`x` = gauche/droite dans l'image, `z` = profondeur) pour obtenir un angle :

```
θ = atan2( z_épaule_droite − z_épaule_gauche ,  x_épaule_gauche − x_épaule_droite )
```

| θ        | Position                                             |
| -------- | ---------------------------------------------------- |
| ≈ 0°     | épaule gauche à droite de l'image → **de face**       |
| ≈ ±90°   | épaules l'une derrière l'autre → **de profil**        |
| ≈ ±180°  | coordonnées `x` inversées → **de dos**                |

L'intérêt : θ est une **grandeur continue**, pas un booléen face/dos. En la
« déroulant » image par image (*unwrapping*), on obtient la rotation cumulée
réelle, et un tour = **360° cumulés dans le même sens**.

### Garde-fous anti-faux-positifs

| Protection                    | Effet                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| **4 secteurs obligatoires**   | Un tour n'est validé que si l'on est passé par face → profil → dos → profil, dans l'ordre |
| **Verrouillage du sens**      | Il faut 40° dans un sens pour démarrer un tour                                            |
| **Annulation sur demi-tour**  | Repartir de 110° en arrière (mesurés depuis le point le plus avancé) annule le tour en cours et le sens suivant repart du point de rebroussement — aucune rotation réelle n'est perdue |
| **Écart max par frame (60°)** | Un saut d'angle aberrant (glitch de tracking) est écrêté, jamais cumulé                    |
| **Durée minimale (400 ms)**   | Un « tour » plus rapide que ça est un bug, pas un humain                                  |
| **Réacquisition (700 ms)**    | Si la personne sort du cadre, l'angle de référence est remis à zéro à son retour           |
| **Fusion épaules + hanches**  | Le bassin confirme le buste (65 % / 35 %) — plus stable si un bras masque une épaule       |
| **Lissage vectoriel**         | Le lissage porte sur le *vecteur*, pas sur l'angle : pas de discontinuité à ±180°          |

Point important : l'anti-triche ne repose pas sur un seuil réglable mais sur le
**cumul signé**. Aller-retour = les deux sens s'annulent : il faut 360° *nets*
dans un même sens pour marquer, quoi qu'il arrive.

### Ce que ça donne en pratique

Mesuré par `npm test` sur 252 manches simulées par amplitude (7 niveaux de
compression de profondeur × 4 niveaux de bruit × 3 vitesses × 3 tirages) :

| La personne oscille de… | Tours comptés à tort |
| ----------------------- | -------------------- |
| ±90° (se dandine)       | 0 %                  |
| ±120°                   | 0 %                  |
| ±150° (demi-tours)      | 0 %                  |
| ±165°                   | 1,6 %                |
| ±175°                   | 9 %                  |
| ±179°                   | 25 %                 |

Autrement dit : **aucun faux positif tant que la personne ne va pas au-delà de
±150°**. Ça ne se dégrade que dans les tout derniers degrés avant le tour
complet — et c'est irréductible : un vrai tour fait 360°, à ±179° l'écart est
de 2°, largement sous le bruit de mesure de MediaPipe. À ce stade la personne a
de toute façon quasiment fait le tour.

Côté comptage, 100 % des manches sont comptées exactement juste sur toute la
plage de `zGain` testée (1,2 → 3,0), y compris à 20 tours en 30 secondes.

### Réglages

Tous les paramètres sont en haut de `public/app.js` dans l'objet `CONFIG`.
Les plus utiles sur le terrain :

- `smoothing` (0.40) — baisser si ça tremble, monter si ça réagit trop lentement
- `zGain` (1.8) — monter si les profils sont mal détectés
- `minTurnMs` (400) — plancher de durée d'un tour
- `modelPath` — passer sur `pose_landmarker_full.task` si tu veux plus de
  précision au prix des FPS (à télécharger dans `public/models/`)

Par défaut : **manche de 15 s, décompte de 5 s**. Pour changer sans toucher
au code (durée en millisecondes, décompte en secondes) :

```bash
ROUND_MS=30000 COUNTDOWN=3 npm start
```

### Mode debug

Sur l'écran de jeu, appuie sur **`D`** : un panneau affiche θ, la rotation
cumulée, le sens verrouillé, les secteurs traversés et l'indice de qualité.
Indispensable pour calibrer sur place le jour J. **`Échap`** abandonne la manche.

---

## 6. Conseils de mise en place le jour J

- **Cadrage** : la personne doit tenir **en pied** dans l'image, à ~2–2,5 m de
  la caméra. C'est le facteur n°1 de fiabilité.
- **Lumière** : éclairage frontal, éviter un contre-jour (fenêtre derrière).
- **Fond** : un fond uni aide beaucoup ; éviter le public qui passe derrière.
- **Consigne** : bras le long du corps ou croisés, pas de bras tendus.
- **Plein écran** : `F11` (Windows/Linux) ou `⌃⌘F` (macOS) pour le mode borne.
- **Tailwind** : chargé via CDN comme demandé. Si le lieu n'a pas de réseau, la
  page reste parfaitement utilisable (les styles critiques sont inline dans
  `index.html`). Pour un rendu 100 % identique hors-ligne :
  ```bash
  curl -o public/tailwind.js https://cdn.tailwindcss.com
  ```
  puis remplace l'URL du `<script>` par `/tailwind.js` dans `index.html`.
- **Webcam** : le flux reste actif entre deux joueurs pour enchaîner vite. Pour
  l'éteindre après chaque manche, appelle `stream.getTracks().forEach(t => t.stop())`
  dans `endRound()` de `app.js`.

---

## 7. Déployer sur une autre machine (Ubuntu)

### Ce qu'il faut transférer

Tout **sauf `node_modules/`** (38 Mo inutiles : `npm install` le régénère).
Le reste fait ~6 Mo.

⚠️ **Piège n°1** : `public/models/pose_landmarker_lite.task` (5,5 Mo) doit être
transféré. Ce n'est **pas** une dépendance npm — si tu l'oublies, la borne
affichera « Moteur indisponible ».

Depuis le Mac :

```bash
rsync -av --exclude node_modules --exclude 'leaderboard*.json' \
  "/Users/pleven/Documents/1 - Dossier tah les ouf/sae alt/V1/" \
  user@ip-ubuntu:~/spin-challenge/
```

Sans réseau entre les deux machines, une archive sur clé USB fait pareil :

```bash
tar --exclude node_modules -czf spin-challenge.tar.gz -C "…/sae alt" V1
```

Le projet ne contient **aucune dépendance native** (0 binaire `.node`) : rien
n'est lié à macOS, tout est du JavaScript et du WebAssembly.

### Installer Node sur Ubuntu

Le paquet `nodejs` d'Ubuntu est souvent trop vieux. Il faut **Node 18 minimum** :

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v          # doit afficher v22.x
```

### Lancer

```bash
cd ~/spin-challenge
npm install
npm test          # vérifie l'algorithme sur cette machine
npm start
```

Puis **http://localhost:3000** dans Google Chrome.

### Performance

MediaPipe passe par le GPU via WebGL. Sans pilotes graphiques corrects, Chrome
bascule en rendu logiciel et ça rame. Vérifie sur `chrome://gpu` que WebGL est
en *Hardware accelerated*.

Le code retombe automatiquement sur le délégué CPU si le GPU échoue, mais c'est
plus lent. Si ça rame encore, baisse la résolution dans `startCamera()`
(`public/app.js`) : 1280×720 → 640×480.

### Mode borne (plein écran, sans barre d'adresse)

```bash
google-chrome --kiosk http://localhost:3000
```

`Alt+F4` pour sortir.

### Démarrage automatique au boot (optionnel)

Pour que le serveur se relance seul si la machine redémarre en plein événement,
crée `/etc/systemd/system/spin-challenge.service` :

```ini
[Unit]
Description=Spin Challenge
After=network.target

[Service]
Type=simple
User=VOTRE_UTILISATEUR
WorkingDirectory=/home/VOTRE_UTILISATEUR/spin-challenge
ExecStart=/usr/bin/node server.js
Environment=ROUND_MS=15000
Environment=COUNTDOWN=5
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now spin-challenge
sudo systemctl status spin-challenge
journalctl -u spin-challenge -f     # logs et scores en direct
```

> Cette procédure Ubuntu n'a pas pu être testée depuis le Mac de développement.
> Vérifie-la sur la borne **avant** le jour J, en particulier l'accès webcam.

---

## 8. Mettre en ligne (URL publique, utilisable sur n'importe quel appareil)

### Pourquoi GitHub Pages ne suffit pas

GitHub Pages ne sert que des fichiers statiques. Cette application a un
**serveur Node** (API classement + tirage de la roulette). Il faut donc un
hébergeur capable d'exécuter `server.js`.

Et surtout : **la webcam exige du HTTPS**. `getUserMedia()` est refusé en HTTP
ailleurs que sur `localhost`. Un hébergeur qui fournit un certificat (c'est le
cas de tous ceux ci-dessous) règle le problème.

### 1. Pousser sur GitHub

Crée un dépôt vide sur <https://github.com/new> (sans README ni .gitignore),
puis :

```bash
git remote add origin https://github.com/TON_PSEUDO/spin-challenge.git
git branch -M main
git push -u origin main
```

### 2. Déployer sur Render (gratuit)

1. <https://render.com> → connexion avec GitHub
2. **New +** → **Blueprint** → choisis ce dépôt
3. Render lit `render.yaml` et déploie tout seul

Tu obtiens une URL du type `https://spin-challenge.onrender.com`, utilisable
depuis n'importe quel téléphone ou ordinateur.

Les autres hébergeurs Node marchent aussi (Railway, Fly.io, Koyeb…). En
revanche **Vercel et Netlify ne conviennent pas** : leur système de fichiers
est en lecture seule, `leaderboard.json` ne pourrait pas être écrit.

### Les limites de l'offre gratuite

| Limite | Conséquence |
| ------ | ----------- |
| **Mise en veille après 15 min d'inactivité** | Le premier visiteur attend ~1 min que le serveur se réveille |
| **Disque éphémère** | `leaderboard.json` est remis à zéro à chaque redéploiement ou redémarrage |
| **CPU partagé** | La détection tourne dans le navigateur du visiteur, donc ça ne change rien aux perfs de jeu |

Le classement qui s'efface est le vrai point à connaître : **pour l'événement,
garde la version locale** (`npm start` sur la borne), où les scores sont
réellement persistants. La version en ligne est parfaite pour tester, montrer
et partager.

### Sur téléphone : ce qui marche et ce qui coince

La détection fonctionne, mais l'algorithme a besoin de voir les **épaules et
les hanches**. Téléphone tenu à bout de bras, on ne voit que le visage et les
tours ne seront pas comptés.

Il faut **caler le téléphone** (contre un objet, sur une table) et reculer de
2 mètres environ. Dans ces conditions ça marche — mais l'expérience reste
pensée pour une borne en écran large.

> Le comportement exact sur iOS Safari et sur les téléphones anciens n'a pas
> été testé : MediaPipe demande WebAssembly + WebGL, disponibles sur les
> navigateurs récents mais parfois lents sur du matériel âgé.


## 9. Dépannage

| Symptôme                                   | Cause / solution                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| « Moteur indisponible »                    | `npm install` non fait, ou modèle absent de `public/models/`                 |
| Page noire, pas de webcam                  | Autorisation refusée → réinitialise la permission du site dans le navigateur |
| Tours comptés en double                    | Monte `smoothing` à 0.55 et `minTurnMs` à 600                                |
| Tours non comptés                          | Recule la personne pour la cadrer en pied ; monte `zGain` à 2.5              |
| Ça rame                                    | Baisse la résolution webcam dans `startCamera()` (1280×720 → 640×480)        |
| Ubuntu : la webcam ne s'ouvre jamais       | Chromium **snap** bloque `/dev/video*` → Google Chrome en `.deb` (§7)        |
| Ubuntu : « Moteur indisponible »           | `public/models/*.task` n'a pas été transféré (§7)                           |
| La manche se coupe toute seule              | L'onglet est passé en arrière-plan : le navigateur gèle la détection, la manche est arrêtée volontairement |
| Score non enregistré                       | Le serveur a coupé — le score s'affiche quand même, relance `npm start`      |
