#!/bin/bash
# Упаковка расширения R-Helper для Chrome и Firefox
set -e

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
    content.js
    content.css
    popup.html
    popup.js
    popup.css
    icons/
)

# --- Chrome ---
CHROME_OUTPUT="${EXTENSION_NAME}-${VERSION}.zip"
rm -f "$CHROME_OUTPUT"
zip -r "$CHROME_OUTPUT" manifest.json "${SHARED_FILES[@]}"
echo "Создан: $CHROME_OUTPUT"

# --- Firefox ---
FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"
rm -f "$FIREFOX_OUTPUT"

# Подменяем manifest.json на Firefox-версию (с восстановлением через trap)
cleanup() { [ -f manifest.json.bak ] && mv manifest.json.bak manifest.json; }
trap cleanup EXIT

cp manifest.json manifest.json.bak
cp manifest.firefox.json manifest.json
zip -r "$FIREFOX_OUTPUT" manifest.json "${SHARED_FILES[@]}"
mv manifest.json.bak manifest.json
trap - EXIT

echo "Создан: $FIREFOX_OUTPUT"

echo ""
echo "Chrome архив:"
unzip -l "$CHROME_OUTPUT"
echo ""
echo "Firefox архив:"
unzip -l "$FIREFOX_OUTPUT"
