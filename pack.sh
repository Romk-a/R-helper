#!/bin/bash
# pack.sh — Сборка расширения R-Helper
#
# Что делает:
#   1. Проверяет, что версии в manifest.json и manifest.firefox.json совпадают
#   2. Собирает Chrome-пакет (.crx) через npx crx
#   3. Собирает Firefox-пакет (.zip)
#
# Требования:
#   - Node.js + npm (для npx crx)
#   - key.pem для подписи Chrome-пакета (создаётся автоматически при первом запуске)
#
# Результат:
#   - r-helper-{version}.crx — Chrome-пакет
#   - r-helper-{version}-chrome.zip — Chrome-пакет для Chrome Web Store
#   - r-helper-{version}-firefox.zip — Firefox-пакет
#
# После сборки протестируй пакеты, затем запусти ./publish.sh для публикации
#
set -e

usage() {
    cat <<'EOF'
pack.sh — сборка пакетов расширения R-Helper

Использование:
  ./pack.sh              собрать пакеты для Chrome и Firefox
  ./pack.sh -h | --help  показать эту справку

Аргументов, кроме справки, скрипт не принимает: версия берётся из manifest.json,
и она должна совпадать с manifest.firefox.json — иначе сборка прервётся.

Что делает:
  1. Сверяет версии в manifest.json и manifest.firefox.json
  2. Собирает Chrome-пакет .crx через npx crx (подпись — key.pem, создаётся при первом запуске)
  3. Собирает Chrome-пакет .zip для Chrome Web Store
  4. Собирает Firefox-пакет .zip

Результат (в каталоге скрипта):
  r-helper-{version}.crx
  r-helper-{version}-chrome.zip
  r-helper-{version}-firefox.zip

Требования: Node.js + npm (для npx crx), zip

После сборки протестируй пакеты, затем запусти ./publish.sh для публикации.
EOF
}

case "${1:-}" in
    -h|--help)
        usage
        exit 0
        ;;
    "")
        ;;
    *)
        echo "ОШИБКА: неизвестный аргумент «$1»" >&2
        echo "" >&2
        usage >&2
        exit 1
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

EXTENSION_NAME="r-helper"
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')

# Проверка совпадения версий
FIREFOX_VERSION=$(grep '"version"' manifest.firefox.json | sed 's/.*: *"\(.*\)".*/\1/')
if [ "$VERSION" != "$FIREFOX_VERSION" ]; then
  echo "ОШИБКА: Версии не совпадают! Chrome=$VERSION, Firefox=$FIREFOX_VERSION"
  exit 1
fi

SHARED_FILES=(
    background.js
    content-shared.js
    content.js
    content-jira.js
    content.css
    popup.html
    popup.js
    popup.css
    theme.js
    changelog.js
    options.html
    options.js
    options.css
    icons
)

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

# --- Chrome (.crx) ---
CHROME_DIR="$TMPDIR_BASE/chrome"
mkdir -p "$CHROME_DIR"
cp manifest.json "$CHROME_DIR/"
for f in "${SHARED_FILES[@]}"; do
    cp -r "$f" "$CHROME_DIR/"
done

CHROME_OUTPUT="${EXTENSION_NAME}-${VERSION}.crx"
rm -f "$CHROME_OUTPUT"

# crx генерирует key.pem при первом запуске, потом переиспользует
npx --yes crx pack "$CHROME_DIR" -o "$SCRIPT_DIR/$CHROME_OUTPUT" -p "$SCRIPT_DIR/key.pem"
echo "Создан: $CHROME_OUTPUT"

# --- Chrome (.zip для Chrome Web Store) ---
CHROME_ZIP="${EXTENSION_NAME}-${VERSION}-chrome.zip"
rm -f "$CHROME_ZIP"
(cd "$CHROME_DIR" && zip -r "$SCRIPT_DIR/$CHROME_ZIP" .)
echo "Создан: $CHROME_ZIP"

# --- Firefox (.xpi, подписанный через AMO) ---
FIREFOX_DIR="$TMPDIR_BASE/firefox"
mkdir -p "$FIREFOX_DIR"
cp manifest.firefox.json "$FIREFOX_DIR/manifest.json"
for f in "${SHARED_FILES[@]}"; do
    cp -r "$f" "$FIREFOX_DIR/"
done

FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"
rm -f "$FIREFOX_OUTPUT"

(cd "$FIREFOX_DIR" && zip -r "$SCRIPT_DIR/$FIREFOX_OUTPUT" .)

echo ""
echo "Сборка завершена:"
ls -lh "$SCRIPT_DIR/$CHROME_OUTPUT" "$SCRIPT_DIR/$CHROME_ZIP" "$SCRIPT_DIR/$FIREFOX_OUTPUT"
echo ""
echo "Протестируй пакеты, затем запусти ./publish.sh для публикации."
