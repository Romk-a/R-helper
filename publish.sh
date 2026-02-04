#!/bin/bash
# publish.sh — Публикация расширения R-Helper
#
# Что делает:
#   1. Проверяет наличие собранных пакетов
#   2. Загружает Firefox-версию на AMO через web-ext sign
#
# Требования:
#   - Собранные пакеты (сначала запусти ./pack.sh)
#   - Node.js + npm (для web-ext)
#   - Файл .env с AMO_JWT_ISSUER и AMO_JWT_SECRET
#
# Использование:
#   ./pack.sh        # собрать пакеты
#   # ... тестирование ...
#   ./publish.sh     # опубликовать
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

EXTENSION_NAME="r-helper"
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')

CHROME_OUTPUT="${EXTENSION_NAME}-${VERSION}.crx"
FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"

# Проверяем наличие пакетов
if [ ! -f "$CHROME_OUTPUT" ] || [ ! -f "$FIREFOX_OUTPUT" ]; then
    echo "ОШИБКА: Пакеты не найдены. Сначала запусти ./pack.sh"
    echo "Ожидаемые файлы: $CHROME_OUTPUT, $FIREFOX_OUTPUT"
    exit 1
fi

echo "Найдены пакеты:"
ls -lh "$CHROME_OUTPUT" "$FIREFOX_OUTPUT"
echo ""

# Загружаем ключи из .env
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# --- Firefox (AMO) ---
if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
    echo "ПРЕДУПРЕЖДЕНИЕ: AMO_JWT_ISSUER и AMO_JWT_SECRET не заданы (проверь .env)"
    echo "Пропускаю публикацию на AMO."
else
    echo "Публикация на AMO..."

    # Распаковываем zip во временную папку для web-ext
    TMPDIR=$(mktemp -d)
    trap 'rm -rf "$TMPDIR"' EXIT

    unzip -q "$FIREFOX_OUTPUT" -d "$TMPDIR/firefox"

    npx --yes web-ext sign \
        --source-dir="$TMPDIR/firefox" \
        --artifacts-dir="$TMPDIR/artifacts" \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=listed

    echo "Firefox: версия $VERSION загружена на AMO (ожидает проверки)"
fi

# --- Chrome Web Store (TODO) ---
# Для публикации в Chrome Web Store нужен Chrome Web Store API
# https://developer.chrome.com/docs/webstore/using_webstore_api/
# Раскомментируй и настрой, когда будет готово:
#
# if [ -z "$CHROME_CLIENT_ID" ] || [ -z "$CHROME_CLIENT_SECRET" ] || [ -z "$CHROME_REFRESH_TOKEN" ]; then
#     echo "ПРЕДУПРЕЖДЕНИЕ: Chrome Web Store credentials не заданы"
# else
#     echo "Публикация в Chrome Web Store..."
#     # ... API вызовы ...
# fi

echo ""
echo "Готово!"
