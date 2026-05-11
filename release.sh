#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# release.sh · Dominio client app
# ═══════════════════════════════════════════════════════════════════
# Automatiza el ciclo completo de release:
#   1. Bump version (package.json)
#   2. Build DMG mac (x64 + arm64)
#   3. Upload DMGs a GitHub Releases (ilimitado free)
#   4. Reescribir latest-mac.yml con URLs absolutas de GitHub
#   5. Copiar yml al landing (dasboard-web-design/updates/mac/)
#   6. Commit + push el landing → Vercel auto-deploy
#
# Cliente app con v2.1.0+ hará autoUpdater.checkForUpdates() cada 4h
# y fetchará https://dominiosystem.com/updates/mac/latest-mac.yml,
# que apunta a los DMGs en GitHub Releases.
#
# Uso:
#   ./release.sh 2.1.3              # bump a 2.1.3 + build + release
#   ./release.sh 2.1.3 --dry-run    # preview sin publicar nada
#   ./release.sh 2.1.3 --no-build   # reutiliza dist/ existente
#
# Requisitos:
#   · gh CLI autenticado con scope 'repo'
#   · git configurado para dominio-client-app y dasboard-web-design
#   · node + electron-builder instalados localmente
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

NEW_VERSION="${1:-}"
DRY_RUN=false
SKIP_BUILD=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --no-build)  SKIP_BUILD=true ;;
  esac
done

if [[ -z "$NEW_VERSION" ]]; then
  echo "❌ Uso: ./release.sh <version> [--dry-run] [--no-build]"
  echo "   Ej:  ./release.sh 2.1.3"
  exit 1
fi

# Validar formato semver
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ Versión inválida: '$NEW_VERSION' · debe ser X.Y.Z (semver)"
  exit 1
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LANDING_DIR="$(cd "$SCRIPT_DIR/../dasboard-web-design" && pwd)"
UPDATES_DIR="$LANDING_DIR/updates/mac"

GITHUB_REPO="dominio-system/dominio-client-app"
RELEASE_TAG="v$NEW_VERSION"
GITHUB_BASE_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG"

echo "═════════════════════════════════════════════════════════════"
echo "  Dominio Release · v$NEW_VERSION"
[[ "$DRY_RUN"    == "true" ]] && echo "  MODO: DRY-RUN (no se publica nada)"
[[ "$SKIP_BUILD" == "true" ]] && echo "  MODO: SKIP-BUILD (reutiliza dist/)"
echo "═════════════════════════════════════════════════════════════"
echo ""

# ─── 0. Prechecks ─────────────────────────────────────────────────
echo "🔍 Verificando prerequisitos…"

[[ -d "$LANDING_DIR" ]] || { echo "❌ Landing dir no encontrado: $LANDING_DIR"; exit 1; }

command -v gh >/dev/null 2>&1 || { echo "❌ gh CLI no instalado"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "❌ node no instalado"; exit 1; }

gh auth status >/dev/null 2>&1 || { echo "❌ gh CLI no autenticado · corré: gh auth login"; exit 1; }

if ! (cd "$SCRIPT_DIR" && git diff --quiet && git diff --cached --quiet); then
  echo "⚠️  Cliente app tiene cambios sin commitear. ¿Continuar? [y/N]"
  read -r confirm
  [[ "$confirm" =~ ^[yY]$ ]] || exit 1
fi

echo "✓ Prerequisitos OK"
echo ""

# ─── 1. Bump version ──────────────────────────────────────────────
cd "$SCRIPT_DIR"
CURRENT_VERSION=$(node -p "require('./package.json').version")

if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
  echo "⚠️  package.json ya está en v$NEW_VERSION (sin cambios)"
else
  echo "📝 Bump version: $CURRENT_VERSION → $NEW_VERSION"
  if [[ "$DRY_RUN" != "true" ]]; then
    node -e "const pkg = require('./package.json'); pkg.version = '$NEW_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');"
  fi
fi
echo ""

# ─── 2. Build DMG ────────────────────────────────────────────────
if [[ "$SKIP_BUILD" == "true" ]]; then
  echo "⏭  SKIP-BUILD activado, usando dist/ existente"
else
  echo "🔨 Building DMG x64 + arm64…"
  if [[ "$DRY_RUN" != "true" ]]; then
    rm -rf dist
    npx electron-builder --mac 2>&1 | tail -5
  else
    echo "   (dry-run: saltando build real)"
  fi
fi

DMG_X64="$SCRIPT_DIR/dist/Dominio-$NEW_VERSION-x64.dmg"
DMG_ARM="$SCRIPT_DIR/dist/Dominio-$NEW_VERSION-arm64.dmg"
YML="$SCRIPT_DIR/dist/latest-mac.yml"

if [[ "$DRY_RUN" != "true" ]]; then
  [[ -f "$DMG_X64" ]] || { echo "❌ DMG x64 no encontrado: $DMG_X64"; exit 1; }
  [[ -f "$DMG_ARM" ]] || { echo "❌ DMG arm64 no encontrado: $DMG_ARM"; exit 1; }
  [[ -f "$YML"     ]] || { echo "❌ latest-mac.yml no encontrado: $YML";  exit 1; }
  echo "✓ Artefactos listos:"
  echo "   · $(ls -lh "$DMG_X64" | awk '{print $5}')  Dominio-$NEW_VERSION-x64.dmg"
  echo "   · $(ls -lh "$DMG_ARM" | awk '{print $5}')  Dominio-$NEW_VERSION-arm64.dmg"
fi
echo ""

# ─── 3. GitHub Release ───────────────────────────────────────────
echo "📦 Publicando GitHub Release $RELEASE_TAG…"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "   (dry-run) gh release create $RELEASE_TAG \\"
  echo "     --repo $GITHUB_REPO \\"
  echo "     --title 'Dominio v$NEW_VERSION' \\"
  echo "     --notes 'Release v$NEW_VERSION' \\"
  echo "     $DMG_X64 $DMG_ARM"
else
  # Si el tag ya existe, lo borramos y re-creamos (idempotente)
  if gh release view "$RELEASE_TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
    echo "   ⚠️  Release $RELEASE_TAG ya existe · sobrescribiendo"
    gh release delete "$RELEASE_TAG" --repo "$GITHUB_REPO" --yes --cleanup-tag 2>/dev/null || true
  fi

  # Subir DMGs + blockmaps · los blockmaps habilitan descargas delta
  # (electron-updater solo baja los bytes cambiados entre versiones)
  RELEASE_FILES=("$DMG_X64" "$DMG_ARM")
  [[ -f "${DMG_X64}.blockmap" ]] && RELEASE_FILES+=("${DMG_X64}.blockmap")
  [[ -f "${DMG_ARM}.blockmap" ]] && RELEASE_FILES+=("${DMG_ARM}.blockmap")

  gh release create "$RELEASE_TAG" \
    --repo "$GITHUB_REPO" \
    --title "Dominio v$NEW_VERSION" \
    --notes "Release automático v$NEW_VERSION · generado por release.sh" \
    "${RELEASE_FILES[@]}"

  echo "✓ Release publicado con $(echo ${#RELEASE_FILES[@]}) assets:"
  echo "   https://github.com/$GITHUB_REPO/releases/tag/$RELEASE_TAG"
fi
echo ""

# ─── 4. Reescribir latest-mac.yml con URLs absolutas ─────────────
echo "📄 Generando latest-mac.yml con URLs de GitHub…"

if [[ "$DRY_RUN" != "true" ]]; then
  # Reemplazar URLs relativas con absolutas de GitHub
  # El yml original tiene: `  - url: Dominio-X.Y.Z.dmg`
  # Lo convertimos a:     `  - url: https://github.com/.../Dominio-X.Y.Z.dmg`
  sed -e "s|url: Dominio-|url: $GITHUB_BASE_URL/Dominio-|g" \
      -e "s|path: Dominio-|path: $GITHUB_BASE_URL/Dominio-|g" \
      "$YML" > /tmp/latest-mac-rewritten.yml

  echo "✓ yml reescrito · preview:"
  head -15 /tmp/latest-mac-rewritten.yml | sed 's/^/     /'
fi
echo ""

# ─── 5. Copiar yml al landing ────────────────────────────────────
echo "📁 Copiando yml al landing ($UPDATES_DIR)…"

if [[ "$DRY_RUN" != "true" ]]; then
  mkdir -p "$UPDATES_DIR"
  cp /tmp/latest-mac-rewritten.yml "$UPDATES_DIR/latest-mac.yml"
  echo "✓ Escrito en $UPDATES_DIR/latest-mac.yml"
fi
echo ""

# ─── 6. Commit + push landing ────────────────────────────────────
echo "🚀 Commit + push landing (Vercel auto-deploy)…"

cd "$LANDING_DIR"

if [[ "$DRY_RUN" != "true" ]]; then
  git add "updates/mac/latest-mac.yml"
  # git diff --cached --quiet devuelve 0 si no hay diff staged → skip commit
  if git diff --cached --quiet -- "updates/mac/latest-mac.yml" 2>/dev/null; then
    echo "   ⚠️  yml sin cambios reales · saltando commit"
  else
    git commit -m "chore(release): v$NEW_VERSION · publicar manifest mac" \
               -m "DMGs hosteados en GitHub Releases: $GITHUB_BASE_URL" \
               -- "updates/mac/latest-mac.yml"
    git push origin HEAD
    echo "✓ Push hecho · Vercel empezará a deployar en ~30s"
  fi
fi
echo ""

# ─── 7. Verificación final ───────────────────────────────────────
echo "═════════════════════════════════════════════════════════════"
echo "  ✅ Release v$NEW_VERSION completo"
echo "═════════════════════════════════════════════════════════════"
echo "  DMGs:            $GITHUB_BASE_URL/"
echo "  Manifest:        https://dominiosystem.com/updates/mac/latest-mac.yml"
echo "  Vercel deploy:   ~30-60s (revisar en vercel.com dashboard)"
echo ""
echo "  Para verificar:"
echo "  1. curl -sI https://dominiosystem.com/updates/mac/latest-mac.yml"
echo "  2. Abrir cliente app → Settings > Apariencia > 'Buscar actualizaciones'"
echo "═════════════════════════════════════════════════════════════"
