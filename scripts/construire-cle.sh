#!/usr/bin/env bash
#
#  Fabrique le kit clé USB hors-ligne : dist/SPIN-CHALLENGE/
#
#      bash scripts/construire-cle.sh                    fabrique le kit
#      bash scripts/construire-cle.sh /Volumes/SPIN      … et le copie sur la clé
#
#  Le kit contient tout ce qu'il faut pour tourner SANS internet sur un PC
#  Linux x86_64, même sans Node installé : le moteur Node pour Linux (vérifié
#  par empreinte SHA-256), les dépendances, le modèle de détection, les
#  polices, et le lanceur.
#
#  À lancer depuis un Mac ou un Linux connecté à internet (téléchargement de
#  Node et des dépendances npm). Compatible bash 3.2.
#
set -euo pipefail

NODE_VERSION="24.22.2"     # LTS « Krypton » — la branche sur laquelle tout est testé
ARCH="linux-x64"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CACHE="$ROOT/.cache-cle"
OUT="$ROOT/dist/SPIN-CHALLENGE"
TARGET="${1:-}"

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }

for t in curl tar npm rsync; do
  command -v "$t" >/dev/null 2>&1 || die "Outil manquant : $t"
done
command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || die "Outil manquant : shasum"

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

# ------------------------------------------------------------------------
step "Moteur Node $NODE_VERSION pour $ARCH"
# ------------------------------------------------------------------------
mkdir -p "$CACHE"
TARBALL="node-v$NODE_VERSION-$ARCH.tar.gz"
BASE="https://nodejs.org/dist/v$NODE_VERSION"

if [ ! -f "$CACHE/$TARBALL" ]; then
  curl -fL --progress-bar "$BASE/$TARBALL" -o "$CACHE/$TARBALL.part"
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
curl -fsSL "$BASE/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
EXPECTED="$(grep " $TARBALL\$" "$CACHE/SHASUMS256-$NODE_VERSION.txt" | awk '{print $1}')"
ACTUAL="$(sha256 "$CACHE/$TARBALL")"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] \
  || { rm -f "$CACHE/$TARBALL"; die "Empreinte SHA-256 invalide pour $TARBALL — fichier supprimé, relance."; }
ok "Empreinte vérifiée ($ACTUAL)"

# ------------------------------------------------------------------------
step "Assemblage du kit"
# ------------------------------------------------------------------------
rm -rf "$OUT"
mkdir -p "$OUT/app" "$OUT/runtime"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar -xzf "$CACHE/$TARBALL" -C "$TMP" \
  "node-v$NODE_VERSION-$ARCH/bin/node" "node-v$NODE_VERSION-$ARCH/LICENSE"
cp "$TMP/node-v$NODE_VERSION-$ARCH/bin/node"  "$OUT/runtime/node"
cp "$TMP/node-v$NODE_VERSION-$ARCH/LICENSE"   "$OUT/runtime/LICENSE-node.txt"
chmod +x "$OUT/runtime/node"
ok "Moteur : runtime/node"

cp "$ROOT/server.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$OUT/app/"
cp -R "$ROOT/public" "$OUT/app/public"
ok "Programme : app/"

( cd "$OUT/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null )
# Aucune dépendance ne doit être compilée pour une plateforme : un module
# natif fabriqué sur le Mac ne tournerait pas sur le PC Linux.
NATIVE="$(find "$OUT/app/node_modules" -name '*.node' | head -1)"
[ -z "$NATIVE" ] || die "Module natif détecté ($NATIVE) : il ne serait pas portable vers Linux."
ok "Dépendances : $(ls "$OUT/app/node_modules" | wc -l | tr -d ' ') paquets, aucun module natif"

cp "$ROOT/usb/LANCER.sh" "$ROOT/usb/REGLAGES.txt" "$ROOT/usb/LISEZ-MOI.txt" "$OUT/"
chmod +x "$OUT/LANCER.sh"

REV="$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null || echo local)"
( cd "$ROOT" && git diff --quiet 2>/dev/null ) || REV="$REV-modifie"
printf '%s_%s\n' "$(date +%Y-%m-%d_%H%M)" "$REV" > "$OUT/VERSION"
ok "Version : $(cat "$OUT/VERSION")"

# Fichiers parasites du Mac
find "$OUT" \( -name '.DS_Store' -o -name '._*' \) -delete

# ------------------------------------------------------------------------
step "Contrôles"
# ------------------------------------------------------------------------
for f in LANCER.sh REGLAGES.txt LISEZ-MOI.txt VERSION runtime/node app/server.js \
         app/public/index.html app/public/board.html app/public/models/pose_landmarker_lite.task \
         app/public/fonts/fonts.css app/node_modules/express app/node_modules/@mediapipe/tasks-vision/wasm; do
  [ -e "$OUT/$f" ] || die "Manquant dans le kit : $f"
done
ok "Tous les fichiers indispensables sont présents"

if grep -rqE "https?://(fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|cdnjs)" "$OUT/app/public" --include='*.html' --include='*.js' --include='*.css'; then
  die "Une page appelle encore une ressource en ligne."
fi
ok "Aucune ressource en ligne dans les pages"

if command -v file >/dev/null 2>&1; then
  file "$OUT/runtime/node" | grep -q "ELF 64-bit.*x86-64" || die "runtime/node n'est pas un binaire Linux x86_64"
  ok "runtime/node : binaire Linux x86_64"
fi

SIZE="$(du -sh "$OUT" | awk '{print $1}')"
ok "Kit prêt : $OUT ($SIZE)"

# ------------------------------------------------------------------------
if [ -n "$TARGET" ]; then
  step "Copie sur $TARGET"
  [ -d "$TARGET" ] || die "Destination introuvable : $TARGET"
  # -rt et pas -a : une clé FAT32/exFAT ne stocke ni propriétaires ni droits.
  rsync -rt --delete --exclude '._*' --exclude '.DS_Store' "$OUT/" "$TARGET/SPIN-CHALLENGE/"
  command -v dot_clean >/dev/null 2>&1 && dot_clean -m "$TARGET/SPIN-CHALLENGE" 2>/dev/null || true
  sync
  ok "Copié dans $TARGET/SPIN-CHALLENGE — tu peux éjecter la clé."
fi
