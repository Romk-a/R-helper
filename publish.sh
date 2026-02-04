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

# --- Скачивание .xpi с AMO ---
XPI_DEST_DIR="/home/rgubarev/www_share"
AMO_API_URL="https://addons.mozilla.org/api/v5/addons/addon/r-helper/"
XPI_TIMEOUT=30

echo ""
echo "Ожидание появления .xpi на AMO (таймаут ${XPI_TIMEOUT}с)..."

XPI_URL=""
START_TIME=$(date +%s)

while true; do
    CURRENT_TIME=$(date +%s)
    ELAPSED=$((CURRENT_TIME - START_TIME))

    if [ $ELAPSED -ge $XPI_TIMEOUT ]; then
        echo "Таймаут: не удалось получить .xpi за ${XPI_TIMEOUT}с"
        break
    fi

    # Запрашиваем API
    API_RESPONSE=$(curl -s "$AMO_API_URL" 2>/dev/null || echo "")

    if [ -n "$API_RESPONSE" ]; then
        # Проверяем версию и получаем URL
        AMO_VERSION=$(echo "$API_RESPONSE" | grep -o '"version":"[^"]*"' | head -1 | sed 's/"version":"\([^"]*\)"/\1/')
        XPI_URL=$(echo "$API_RESPONSE" | grep -o '"url":"https://addons.mozilla.org/firefox/downloads/file/[^"]*\.xpi[^"]*"' | head -1 | sed 's/"url":"\([^"]*\)"/\1/')

        if [ "$AMO_VERSION" = "$VERSION" ] && [ -n "$XPI_URL" ]; then
            echo "Найдена версия $AMO_VERSION на AMO"
            break
        fi
    fi

    sleep 2
done

if [ -n "$XPI_URL" ]; then
    XPI_FILENAME="${EXTENSION_NAME}-${VERSION}.xpi"
    echo "Скачивание: $XPI_URL"

    if curl -sL --max-time 30 -o "$XPI_DEST_DIR/$XPI_FILENAME" "$XPI_URL"; then
        echo "Сохранено: $XPI_DEST_DIR/$XPI_FILENAME"
        ls -lh "$XPI_DEST_DIR/$XPI_FILENAME"
    else
        echo "ОШИБКА: не удалось скачать .xpi"
    fi
else
    echo "Не удалось получить ссылку на .xpi (возможно, версия ещё на модерации)"
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
