#!/bin/bash
# publish.sh — Публикация расширения R-Helper
#
# Что делает:
#   1. Проверяет наличие собранных пакетов
#   2. Загружает Firefox-версию на AMO через web-ext sign
#   3. Скачивает подписанный .xpi с AMO
#   4. Загружает и публикует Chrome-версию в Chrome Web Store
#
# Требования:
#   - Собранные пакеты (сначала запусти ./pack.sh)
#   - Node.js + npm (для web-ext)
#   - Файл .env с credentials (см. .env для списка переменных)
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
CHROME_ZIP="${EXTENSION_NAME}-${VERSION}-chrome.zip"
FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"

# Проверяем наличие пакетов
MISSING=()
[ ! -f "$CHROME_OUTPUT" ] && MISSING+=("$CHROME_OUTPUT")
[ ! -f "$CHROME_ZIP" ] && MISSING+=("$CHROME_ZIP")
[ ! -f "$FIREFOX_OUTPUT" ] && MISSING+=("$FIREFOX_OUTPUT")

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ОШИБКА: Пакеты не найдены. Сначала запусти ./pack.sh"
    echo "Отсутствуют: ${MISSING[*]}"
    exit 1
fi

echo "Найдены пакеты:"
ls -lh "$CHROME_OUTPUT" "$CHROME_ZIP" "$FIREFOX_OUTPUT"
echo ""

# Загружаем ключи из .env
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# --- Firefox (AMO) ---
publish_firefox() {
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo "ПРЕДУПРЕЖДЕНИЕ: AMO_JWT_ISSUER и/или AMO_JWT_SECRET не заданы (проверь .env)"
        return 1
    fi

    echo "Публикация на AMO..."

    # Распаковываем zip во временную папку для web-ext
    local tmpdir
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' RETURN

    unzip -q "$FIREFOX_OUTPUT" -d "$tmpdir/firefox"

    npx --yes web-ext sign \
        --source-dir="$tmpdir/firefox" \
        --artifacts-dir="$tmpdir/artifacts" \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=listed

    echo "Firefox: версия $VERSION загружена на AMO (ожидает проверки)"
}

while true; do
    if publish_firefox; then
        break
    fi
    echo ""
    read -rp "[R]etry / [S]kip? " choice
    case "$choice" in
        [rR]) echo "Повтор..."; continue ;;
        [sS]) echo "Пропускаю публикацию на AMO."; break ;;
        *) echo "Введи R или S" ;;
    esac
done

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

# --- Chrome Web Store ---
publish_chrome() {
    if [ -z "$CHROME_EXTENSION_ID" ] || [ -z "$CHROME_PUBLISHER_ID" ] || \
       [ -z "$CHROME_CLIENT_ID" ] || [ -z "$CHROME_CLIENT_SECRET" ] || [ -z "$CHROME_REFRESH_TOKEN" ]; then
        echo "ПРЕДУПРЕЖДЕНИЕ: Chrome Web Store credentials не заданы (проверь .env)"
        echo "Нужны: CHROME_EXTENSION_ID, CHROME_PUBLISHER_ID, CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN"
        return 1
    fi

    echo "Публикация в Chrome Web Store..."

    # 1. Получаем access token
    echo "  Получение access token..."
    TOKEN_RESPONSE=$(curl -s -X POST "https://oauth2.googleapis.com/token" \
        --data-urlencode "client_id=$CHROME_CLIENT_ID" \
        --data-urlencode "client_secret=$CHROME_CLIENT_SECRET" \
        --data-urlencode "refresh_token=$CHROME_REFRESH_TOKEN" \
        --data-urlencode "grant_type=refresh_token")

    ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token" *: *"[^"]*"' | sed 's/"access_token" *: *"\([^"]*\)"/\1/')

    if [ -z "$ACCESS_TOKEN" ]; then
        echo "ОШИБКА: не удалось получить access token"
        echo "Ответ: $TOKEN_RESPONSE"
        return 1
    fi
    echo "  Access token получен"

    # 2. Загружаем zip
    echo "  Загрузка $CHROME_ZIP..."
    UPLOAD_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "x-goog-api-version: 2" \
        -T "$CHROME_ZIP" \
        "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$CHROME_EXTENSION_ID")

    UPLOAD_STATE=$(echo "$UPLOAD_RESPONSE" | grep -o '"uploadState" *: *"[^"]*"' | sed 's/"uploadState" *: *"\([^"]*\)"/\1/')

    if [ "$UPLOAD_STATE" != "SUCCESS" ]; then
        echo "ОШИБКА: загрузка не удалась (uploadState=$UPLOAD_STATE)"
        echo "Ответ: $UPLOAD_RESPONSE"
        return 1
    fi
    echo "  Загрузка завершена"

    # 3. Публикуем
    echo "  Публикация..."
    PUBLISH_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "x-goog-api-version: 2" \
        -H "Content-Length: 0" \
        "https://www.googleapis.com/chromewebstore/v1.1/items/$CHROME_EXTENSION_ID/publish")

    PUBLISH_STATUS=$(echo "$PUBLISH_RESPONSE" | grep -o '"status" *: *\[[^]]*\]' | grep -o '"[A-Z_]*"' | head -1 | tr -d '"')

    if [ "$PUBLISH_STATUS" != "OK" ] && [ "$PUBLISH_STATUS" != "PUBLISHED_WITH_FRICTION_WARNING" ]; then
        echo "ОШИБКА: публикация не удалась (status=$PUBLISH_STATUS)"
        echo "Ответ: $PUBLISH_RESPONSE"
        return 1
    fi

    echo "Chrome: версия $VERSION опубликована в Chrome Web Store (status=$PUBLISH_STATUS)"
}

echo ""
while true; do
    if publish_chrome; then
        break
    fi
    echo ""
    read -rp "[R]etry / [S]kip? " choice
    case "$choice" in
        [rR]) echo "Повтор..."; continue ;;
        [sS]) echo "Пропускаю публикацию в Chrome Web Store."; break ;;
        *) echo "Введи R или S" ;;
    esac
done

echo ""
echo "Готово!"
