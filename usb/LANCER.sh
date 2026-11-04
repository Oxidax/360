#!/usr/bin/env bash
#
#  SPIN CHALLENGE — lanceur hors-ligne
#  ----------------------------------
#  Démarre tout le dispositif sur un PC Linux, sans connexion internet :
#  le serveur, la fenêtre de la BORNE (webcam + jeu) et celle du MUR
#  (classement géant).
#
#      bash LANCER.sh                 lancer
#      bash LANCER.sh --remise-a-zero vider le classement (avec sauvegarde)
#
#  Pourquoi `bash LANCER.sh` plutôt que `./LANCER.sh` : une clé USB en
#  FAT32 ne stocke pas le droit d'exécution et Linux la monte souvent sans
#  le permettre. `bash` lit le fichier sans avoir besoin de ce droit.
#  Pour la même raison, rien n'est exécuté depuis la clé : le programme est
#  recopié sur le disque du PC (une fois par version) et lancé de là.
#
#  Écrit pour bash 3.2+ (testable sur macOS, tourne sur tout Linux).
#
set -u

SELF="${BASH_SOURCE[0]}"
SRC="$(cd "$(dirname "$SELF")" && pwd -P)"
# Chemin absolu : la relance dans un terminal (ci-dessous) ne part pas
# forcément du même dossier, un chemin relatif n'y retrouverait plus le script.
SELF="$SRC/$(basename "$SELF")"
DEST="${SPIN_HOME:-$HOME/SpinChallenge}"

MODE="lancer"
case "${1:-}" in
  --remise-a-zero) MODE="raz" ;;
  -h|--help) sed -n '3,18p' "$SELF"; exit 0 ;;
esac

# ------------------------------------------------------------------------
#  Une fenêtre de terminal, toujours
# ------------------------------------------------------------------------
# Lancé par un double-clic, le script tournerait sans fenêtre : aucun moyen
# de voir une erreur, ni d'arrêter proprement. On se relance donc dans un
# terminal s'il n'y en a pas.
if [ ! -t 1 ] && [ -z "${SPIN_IN_TERM:-}" ] && [ -z "${SPIN_NO_TERM:-}" ]; then
  export SPIN_IN_TERM=1
  for t in konsole gnome-terminal xfce4-terminal mate-terminal lxterminal x-terminal-emulator xterm; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$t" in
      gnome-terminal|mate-terminal) exec "$t" -- bash "$SELF" "$@" ;;
      xfce4-terminal)               exec "$t" -x bash "$SELF" "$@" ;;
      *)                            exec "$t" -e bash "$SELF" "$@" ;;
    esac
  done
fi

# ------------------------------------------------------------------------
#  Affichage
# ------------------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
else B=''; G=''; Y=''; R=''; Z=''; fi
say()  { printf '  %s\n' "$1"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$Z" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$1"; }
pause_before_exit() {
  # La fenêtre ne doit pas se refermer avant qu'on ait pu lire le message.
  if [ -t 0 ]; then printf '\n  Appuie sur Entrée pour fermer… '; read -r _; fi
}
die() {
  printf '\n  %s✘ %s%s\n' "$R" "$1" "$Z"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/    /'
  pause_before_exit
  exit 1
}

echo
printf '  %s🌀  SPIN CHALLENGE%s\n' "$B" "$Z"
echo "  ─────────────────────────────────────────────────"

# ------------------------------------------------------------------------
#  1. La machine
# ------------------------------------------------------------------------
if [ -z "${SPIN_NODE:-}" ]; then
  [ "$(uname -s)" = "Linux" ] || die "Ce lanceur est prévu pour Linux."
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) die "Processeur $(uname -m) non pris en charge." \
           "Le moteur embarqué est prévu pour les PC classiques (x86_64)." ;;
  esac
fi

# ------------------------------------------------------------------------
#  2. Installation sur le PC (une fois par version)
# ------------------------------------------------------------------------
install_from_stick() {
  [ -f "$SRC/VERSION" ] && [ -d "$SRC/app" ] && [ -d "$SRC/runtime" ] \
    || die "Dossier incomplet : $SRC" "Il manque app/, runtime/ ou VERSION. Recopie le dossier SPIN-CHALLENGE en entier."

  mkdir -p "$DEST/donnees" "$DEST/profils" || die "Impossible de créer $DEST"

  if [ -f "$DEST/VERSION" ] && cmp -s "$SRC/VERSION" "$DEST/VERSION"; then
    ok "Programme déjà installé sur ce PC ($(cat "$DEST/VERSION"))"
  else
    say "Installation sur ce PC — une seule fois par version, ~20 s…"
    rm -rf "$DEST/app.new" "$DEST/runtime.new"
    cp -R "$SRC/app" "$DEST/app.new" && cp -R "$SRC/runtime" "$DEST/runtime.new" \
      || { rm -rf "$DEST/app.new" "$DEST/runtime.new"
           die "La copie a échoué." "Vérifie l'espace libre sur le disque du PC (~250 Mo)."; }
    rm -rf "$DEST/app" "$DEST/runtime"
    mv "$DEST/app.new" "$DEST/app"
    mv "$DEST/runtime.new" "$DEST/runtime"
    cp "$SRC/LANCER.sh" "$DEST/LANCER.sh"
    [ -f "$SRC/LISEZ-MOI.txt" ] && cp "$SRC/LISEZ-MOI.txt" "$DEST/LISEZ-MOI.txt"
    # VERSION en dernier : une copie interrompue sera refaite au prochain
    # lancement au lieu de laisser un programme à moitié installé.
    cp "$SRC/VERSION" "$DEST/VERSION"
    ok "Installé dans $DEST"
  fi
  # Quand on lance depuis la clé, ce sont ses réglages qui font foi.
  [ -f "$SRC/REGLAGES.txt" ] && cp "$SRC/REGLAGES.txt" "$DEST/REGLAGES.txt"
  chmod +x "$DEST/runtime/node" "$DEST/LANCER.sh" 2>/dev/null
}

FROM_STICK=0
if [ "$SRC" != "$(cd "$DEST" 2>/dev/null && pwd -P)" ]; then
  FROM_STICK=1
  install_from_stick
else
  ok "Lancement depuis le PC ($(cat "$DEST/VERSION" 2>/dev/null || echo '?'))"
fi
cd "$DEST" || die "Dossier introuvable : $DEST"

NODE="${SPIN_NODE:-$DEST/runtime/node}"
NODE_V="$("$NODE" --version 2>&1)" \
  || die "Le moteur ne démarre pas sur ce PC." "$NODE_V
Système probablement trop ancien (il faut glibc 2.28+, soit Ubuntu 20.04 ou plus récent)."
ok "Moteur Node $NODE_V"

# ------------------------------------------------------------------------
#  3. Réglages
# ------------------------------------------------------------------------
DUREE=10; DECOMPTE=5; PORT=3000
BORNE_PLEIN_ECRAN=oui; OUVRIR_BORNE=oui; OUVRIR_MUR=oui; NAVIGATEUR=auto
MUR_LIGNES=1,3,3,3,3; MUR_HAUTEUR_ECRAN=; MUR_HAUT=; MUR_REPERES=non

# Lecture prudente : le fichier a pu être modifié sous Windows ou macOS
# (fins de ligne \r\n), et il ne faut surtout pas l'exécuter tel quel.
read_settings() {
  [ -f "$1" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(printf '%s' "$line" | tr -d '\r')"
    case "$line" in ''|\#*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="$(printf '%s' "${line%%=*}" | tr -d ' \t')"
    val="$(printf '%s' "${line#*=}" | sed 's/[[:space:]]*#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    val="$(printf '%s' "$val" | tr 'A-Z' 'a-z')"
    case "$key" in
      DUREE)             is_int "$val" 3 120   && DUREE="$val"    || bad "$key" "$val" ;;
      DECOMPTE)          is_int "$val" 0 10    && DECOMPTE="$val" || bad "$key" "$val" ;;
      PORT)              is_int "$val" 1024 65535 && PORT="$val"  || bad "$key" "$val" ;;
      BORNE_PLEIN_ECRAN) is_yn "$val" && BORNE_PLEIN_ECRAN="$val"  || bad "$key" "$val" ;;
      OUVRIR_BORNE)      is_yn "$val" && OUVRIR_BORNE="$val"       || bad "$key" "$val" ;;
      OUVRIR_MUR)        is_yn "$val" && OUVRIR_MUR="$val"         || bad "$key" "$val" ;;
      MUR_REPERES)       is_yn "$val" && MUR_REPERES="$val"        || bad "$key" "$val" ;;
      NAVIGATEUR)        case "$val" in auto|firefox|chromium|chrome) NAVIGATEUR="$val" ;; *) bad "$key" "$val" ;; esac ;;
      MUR_LIGNES)        case "$val" in *[!0-9,]*|'') bad "$key" "$val" ;; *) MUR_LIGNES="$val" ;; esac ;;
      MUR_HAUTEUR_ECRAN) [ -z "$val" ] || is_int "$val" 200 10000 && MUR_HAUTEUR_ECRAN="$val" || bad "$key" "$val" ;;
      MUR_HAUT)          [ -z "$val" ] || is_int "$val" 0 2000    && MUR_HAUT="$val"          || bad "$key" "$val" ;;
      *) warn "Réglage inconnu ignoré : $key" ;;
    esac
  done < "$1"
}
is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; }
is_yn()  { [ "$1" = oui ] || [ "$1" = non ]; }
bad()    { warn "Réglage ignoré (valeur invalide) : $1=$2"; }

read_settings "$DEST/REGLAGES.txt"

URL_BORNE="http://localhost:$PORT/"
URL_MUR="http://localhost:$PORT/board?rows=$MUR_LIGNES"
[ -n "$MUR_HAUTEUR_ECRAN" ] && URL_MUR="$URL_MUR&h=$MUR_HAUTEUR_ECRAN"
[ -n "$MUR_HAUT" ]          && URL_MUR="$URL_MUR&top=$MUR_HAUT"
[ "$MUR_REPERES" = oui ]    && URL_MUR="$URL_MUR&guides=1"

# Notre serveur répond-il ? (`wheel` n'existe que dans notre API : on ne
# confond pas avec un autre programme qui occuperait le même port.)
probe() {
  "$NODE" -e "fetch('http://127.0.0.1:$PORT/api/config',{signal:AbortSignal.timeout(1500)})
    .then(r=>r.json()).then(j=>process.exit(j&&j.wheel?0:2)).catch(()=>process.exit(1))" 2>/dev/null
}
port_busy() {
  "$NODE" -e "const s=require('net').connect($PORT,'127.0.0.1');
    s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))" 2>/dev/null
}

# ------------------------------------------------------------------------
#  Remise à zéro du classement
# ------------------------------------------------------------------------
if [ "$MODE" = raz ]; then
  echo
  if probe; then
    "$NODE" -e "fetch('http://127.0.0.1:$PORT/api/leaderboard',{method:'DELETE'})
      .then(r=>r.json()).then(j=>{console.log(j.backup?'  sauvegarde : donnees/'+j.backup:'');process.exit(j.ok?0:1)})
      .catch(()=>process.exit(1))" \
      && ok "Classement vidé (le mur se met à jour tout seul)" \
      || die "La remise à zéro a échoué."
  elif [ -f "$DEST/donnees/leaderboard.json" ]; then
    b="$DEST/donnees/leaderboard.backup-$(date +%Y%m%d-%H%M%S).json"
    mv "$DEST/donnees/leaderboard.json" "$b" && ok "Classement vidé — sauvegarde : $b"
  else
    ok "Le classement est déjà vide."
  fi
  pause_before_exit; exit 0
fi

# ------------------------------------------------------------------------
#  4. Serveur (relancé automatiquement s'il s'arrête)
# ------------------------------------------------------------------------
STOPPING=0; SERVER_PID=""; INHIBIT_PID=""; PIDS_BROWSER=""
ALREADY=0
if probe; then
  ALREADY=1
  warn "Le serveur tourne déjà — on ouvre seulement les fenêtres."
elif port_busy; then
  die "Le port $PORT est occupé par un autre programme." \
      "Change PORT dans REGLAGES.txt (par exemple PORT=3100), puis relance."
fi

start_server() {
  PORT="$PORT" ROUND_MS=$((DUREE * 1000)) COUNTDOWN="$DECOMPTE" \
  DATA_DIR="$DEST/donnees" NODE_ENV=production \
    "$NODE" "$DEST/app/server.js" &
  SERVER_PID=$!
}

wait_until_up() {
  local i=0
  while [ $i -lt 60 ]; do
    probe && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 0.3; i=$((i + 1))
  done
  return 1
}

cleanup() {
  STOPPING=1
  trap - INT TERM HUP EXIT
  echo; say "Arrêt…"
  # shellcheck disable=SC2086
  [ -n "$PIDS_BROWSER" ] && kill $PIDS_BROWSER 2>/dev/null
  pkill -f -- "--profile $DEST/profils/" 2>/dev/null
  pkill -f -- "--user-data-dir=$DEST/profils/" 2>/dev/null
  [ -n "$SERVER_PID" ] && { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
  [ -n "$INHIBIT_PID" ] && { kill "$INHIBIT_PID" 2>/dev/null; wait "$INHIBIT_PID" 2>/dev/null; }
  [ -n "${DISPLAY:-}" ] && command -v xset >/dev/null 2>&1 && xset s on +dpms 2>/dev/null
  # Copie de sécurité des scores sur la clé, si elle est encore là.
  if [ $FROM_STICK = 1 ] && [ -f "$DEST/donnees/leaderboard.json" ] \
     && mkdir -p "$SRC/sauvegarde-scores" 2>/dev/null \
     && cp "$DEST/donnees/leaderboard.json" "$SRC/sauvegarde-scores/leaderboard.json" 2>/dev/null; then
    ok "Scores sauvegardés aussi sur la clé (sauvegarde-scores/)"
  fi
  ok "Arrêté."
  exit 0
}

if [ $ALREADY = 0 ]; then
  # Le piège est posé AVANT tout démarrage : fermer la fenêtre pendant le
  # lancement laissait sinon le serveur tourner, orphelin, et le lanceur
  # suivant se contentait de le constater sans plus rien surveiller.
  trap cleanup INT TERM HUP EXIT
  start_server
  wait_until_up || { trap - INT TERM HUP EXIT; kill "$SERVER_PID" 2>/dev/null
                     die "Le serveur n'a pas démarré." "Les messages ci-dessus indiquent la cause."; }
  ok "Serveur prêt — manche de ${DUREE} s, décompte de ${DECOMPTE} s"
fi

# ------------------------------------------------------------------------
#  5. Écrans toujours allumés
# ------------------------------------------------------------------------
# Une borne qui se met en veille au milieu d'un événement… Les pages
# demandent elles-mêmes à garder l'écran allumé ; on double côté système.
# (Seulement pour le lanceur qui pilote le serveur : un second lanceur
# laisserait sinon son verrou derrière lui en partant, et plus jamais les
# écrans ne se mettraient en veille.)
if [ $ALREADY = 0 ] && command -v systemd-inhibit >/dev/null 2>&1; then
  systemd-inhibit --what=idle:sleep --who="Spin Challenge" --why="Borne en service" \
    --mode=block sleep 2147483647 >/dev/null 2>&1 &
  INHIBIT_PID=$!
fi
if [ $ALREADY = 0 ] && [ -n "${DISPLAY:-}" ] && command -v xset >/dev/null 2>&1; then
  xset s off s noblank -dpms 2>/dev/null && ok "Mise en veille des écrans désactivée"
fi

# ------------------------------------------------------------------------
#  6. Navigateurs
# ------------------------------------------------------------------------
BROWSER=""; KIND=""
pick_browser() {
  local list b
  case "$NAVIGATEUR" in
    firefox)  list="firefox firefox-esr" ;;
    chromium) list="chromium chromium-browser" ;;
    chrome)   list="google-chrome google-chrome-stable" ;;
    *)        list="firefox firefox-esr chromium chromium-browser google-chrome google-chrome-stable" ;;
  esac
  for b in $list; do
    if command -v "$b" >/dev/null 2>&1; then
      BROWSER="$b"
      case "$b" in firefox*) KIND=firefox ;; *) KIND=chromium ;; esac
      return 0
    fi
  done
  return 1
}

# Profils dédiés, régénérés à chaque lancement : aucune question au
# démarrage, caméra autorisée d'office pour la borne, et chaque fenêtre
# retrouve la place et la taille où on l'a laissée la fois précédente.
firefox_profile() {   # $1 = dossier, $2 = borne|mur
  mkdir -p "$1"
  cat > "$1/user.js" <<'PREFS'
// Généré par LANCER.sh à chaque démarrage — inutile de le modifier.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.startup.page", 0);
user_pref("browser.startup.upgradeDialog.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.auto", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("signon.rememberSignons", false);
user_pref("extensions.pocket.enabled", false);
user_pref("browser.uitour.enabled", false);
user_pref("full-screen-api.warning.timeout", 0);
user_pref("media.autoplay.default", 0);
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
PREFS
  if [ "$2" = borne ]; then
    cat >> "$1/user.js" <<'PREFS'
// Borne : la caméra est autorisée sans boîte de dialogue, et sans la
// petite fenêtre flottante « Firefox partage votre caméra ».
user_pref("media.navigator.permission.disabled", true);
user_pref("privacy.webrtc.hideGlobalIndicator", true);
user_pref("privacy.webrtc.legacyGlobalIndicator", false);
PREFS
  else
    # Mur : ni onglets ni barre d'adresse, la page occupe toute la fenêtre.
    mkdir -p "$1/chrome"
    printf '%s\n' "#navigator-toolbox { visibility: collapse !important; }" > "$1/chrome/userChrome.css"
  fi
}

open_window() {   # $1 = borne|mur, $2 = url
  local dir="$DEST/profils/$1"
  # Une fenêtre déjà ouverte sur ce profil : Firefox refuserait d'en ouvrir
  # une seconde (« Firefox est déjà ouvert ») — on la laisse telle quelle.
  if pgrep -f -- "profils/$1( |-chromium|$)" >/dev/null 2>&1; then
    warn "Fenêtre $(printf '%s' "$1" | tr a-z A-Z) déjà ouverte"
    return 1
  fi
  if [ "$KIND" = firefox ]; then
    firefox_profile "$dir" "$1"
    if [ "$1" = borne ] && [ "$BORNE_PLEIN_ECRAN" = oui ]; then
      "$BROWSER" --no-remote --new-instance --profile "$dir" --kiosk "$2" >/dev/null 2>&1 &
    else
      "$BROWSER" --no-remote --new-instance --profile "$dir" "$2" >/dev/null 2>&1 &
    fi
  else
    local common="--user-data-dir=$dir-chromium --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required"
    if [ "$1" = borne ]; then
      # shellcheck disable=SC2086
      "$BROWSER" $common --use-fake-ui-for-media-stream \
        $([ "$BORNE_PLEIN_ECRAN" = oui ] && echo --kiosk) "$2" >/dev/null 2>&1 &
    else
      # shellcheck disable=SC2086
      "$BROWSER" $common --app="$2" >/dev/null 2>&1 &
    fi
  fi
  PIDS_BROWSER="$PIDS_BROWSER $!"
}

if [ -n "${SPIN_NO_BROWSER:-}" ]; then
  warn "Navigateurs non ouverts (SPIN_NO_BROWSER)"
elif [ "$OUVRIR_MUR" = non ] && [ "$OUVRIR_BORNE" = non ]; then
  warn "Aucune fenêtre demandée (REGLAGES.txt)"
elif pick_browser; then
  [ "$KIND" = chromium ] && case "$(command -v "$BROWSER")" in /snap/*)
    warn "$BROWSER est installé en snap : il peut bloquer la webcam. Firefox est préférable." ;; esac
  [ "$OUVRIR_MUR" = oui ] && open_window mur "$URL_MUR" && { ok "Fenêtre du MUR ouverte"; sleep 1.5; }
  [ "$OUVRIR_BORNE" = oui ] && open_window borne "$URL_BORNE" && ok "Fenêtre de la BORNE ouverte ($BROWSER)"
else
  warn "Aucun navigateur trouvé (Firefox, Chromium ou Chrome)."
  warn "Ouvre toi-même :  $URL_BORNE   et   $URL_MUR"
fi

# ------------------------------------------------------------------------
#  7. Raccourci sur le bureau du PC (pour les fois suivantes)
# ------------------------------------------------------------------------
make_shortcut() {
  [ "$(uname -s)" = Linux ] || return 0
  local apps="$HOME/.local/share/applications" entry desk
  entry="$apps/spin-challenge.desktop"
  mkdir -p "$apps" 2>/dev/null || return 0
  cat > "$entry" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Spin Challenge
Comment=Borne et mur d'écrans, sans connexion
Exec=bash "$DEST/LANCER.sh"
Path=$DEST
Icon=$DEST/app/public/brand/favicon.png
Terminal=true
Categories=Game;
DESKTOP
  chmod +x "$entry" 2>/dev/null
  gio set "$entry" metadata::trusted true >/dev/null 2>&1
  desk="$(xdg-user-dir DESKTOP 2>/dev/null)"
  [ -d "${desk:-}" ] || for d in "$HOME/Bureau" "$HOME/Desktop"; do [ -d "$d" ] && desk="$d" && break; done
  if [ -d "${desk:-}" ] && [ ! -f "$desk/spin-challenge.desktop" ]; then
    cp "$entry" "$desk/spin-challenge.desktop" 2>/dev/null
    chmod +x "$desk/spin-challenge.desktop" 2>/dev/null
    gio set "$desk/spin-challenge.desktop" metadata::trusted true >/dev/null 2>&1
    ok "Icône « Spin Challenge » ajoutée sur le bureau"
  fi
  update-desktop-database "$apps" >/dev/null 2>&1
  kbuildsycoca6 --noincremental >/dev/null 2>&1 || kbuildsycoca5 --noincremental >/dev/null 2>&1
  return 0
}
make_shortcut

# ------------------------------------------------------------------------
#  8. En service
# ------------------------------------------------------------------------

echo "  ─────────────────────────────────────────────────"
say "${B}BORNE${Z}  $URL_BORNE"
say "${B}MUR${Z}    $URL_MUR"
say "Scores : $DEST/donnees/leaderboard.json"
say "Pour tout arrêter : ferme cette fenêtre, ou Ctrl+C."
echo "  ─────────────────────────────────────────────────"
echo

if [ $ALREADY = 1 ]; then
  # Rien à surveiller : un autre lanceur s'occupe déjà du serveur — et ce
  # n'est surtout pas à nous de fermer ses fenêtres en partant.
  trap - INT TERM HUP EXIT
  pause_before_exit; exit 0
fi

# Si le serveur s'arrête tout seul, on le relance : les pages se
# reconnectent d'elles-mêmes et les scores sont sur le disque.
while :; do
  wait "$SERVER_PID"
  code=$?
  [ $STOPPING = 1 ] && break
  warn "Le serveur s'est arrêté (code $code) — redémarrage dans 2 s…"
  sleep 2
  start_server
  wait_until_up && ok "Serveur relancé" || warn "Échec du redémarrage, nouvelle tentative…"
done
