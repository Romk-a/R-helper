#!/bin/bash
# Упаковка расширения R-Helper для Chrome (.crx) и Firefox (.xpi)
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

# --- Firefox (.xpi, подписанный через AMO) ---
FIREFOX_DIR="$TMPDIR_BASE/firefox"
mkdir -p "$FIREFOX_DIR"
cp manifest.firefox.json "$FIREFOX_DIR/manifest.json"
for f in "${SHARED_FILES[@]}"; do
    cp -r "$f" "$FIREFOX_DIR/"
done

# Загружаем ключи из .env
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
    echo "ОШИБКА: AMO_JWT_ISSUER и AMO_JWT_SECRET не заданы (проверьте .env)"
    exit 1
fi

FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"
rm -f "$FIREFOX_OUTPUT"

# Сохраняем локальную копию zip для архива
(cd "$FIREFOX_DIR" && zip -r "$SCRIPT_DIR/$FIREFOX_OUTPUT" .)

npx --yes web-ext sign \
    --source-dir="$FIREFOX_DIR" \
    --artifacts-dir="$TMPDIR_BASE/artifacts" \
    --api-key="$AMO_JWT_ISSUER" \
    --api-secret="$AMO_JWT_SECRET" \
    --channel=listed

echo "Firefox: версия $VERSION загружена на AMO (ожидает проверки)"

echo ""
echo "Результат:"
ls -lh "$SCRIPT_DIR/$CHROME_OUTPUT" "$SCRIPT_DIR/$FIREFOX_OUTPUT"
echo "Firefox listed-версия загружена на AMO и ожидает проверки."
