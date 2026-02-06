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
#   ./pack.sh                # собрать пакеты
#   # ... тестирование ...
#   ./publish.sh             # опубликовать всё
#   ./publish.sh --firefox   # только Firefox (AMO)
#   ./publish.sh --chrome    # только Chrome (CWS)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# --- Разбор аргументов ---
DO_FIREFOX=false
DO_CHROME=false

case "${1:-}" in
    --firefox) DO_FIREFOX=true ;;
    --chrome)  DO_CHROME=true ;;
    "")        DO_FIREFOX=true; DO_CHROME=true ;;
    *)
        echo "Использование: $0 [--firefox | --chrome]"
        echo "  без аргументов — публикация в оба магазина"
        echo "  --firefox      — только AMO"
        echo "  --chrome       — только Chrome Web Store"
        exit 1
        ;;
esac

EXTENSION_NAME="r-helper"
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')

CHROME_OUTPUT="${EXTENSION_NAME}-${VERSION}.crx"
CHROME_ZIP="${EXTENSION_NAME}-${VERSION}-chrome.zip"
FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"

# Проверяем наличие пакетов (только нужных)
MISSING=()
if $DO_FIREFOX; then
    [ ! -f "$FIREFOX_OUTPUT" ] && MISSING+=("$FIREFOX_OUTPUT")
fi
if $DO_CHROME; then
    [ ! -f "$CHROME_OUTPUT" ] && MISSING+=("$CHROME_OUTPUT")
    [ ! -f "$CHROME_ZIP" ] && MISSING+=("$CHROME_ZIP")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ОШИБКА: Пакеты не найдены. Сначала запусти ./pack.sh"
    echo "Отсутствуют: ${MISSING[*]}"
    exit 1
fi

echo "Найдены пакеты:"
if $DO_FIREFOX; then ls -lh "$FIREFOX_OUTPUT"; fi
if $DO_CHROME; then ls -lh "$CHROME_OUTPUT" "$CHROME_ZIP"; fi
echo ""

# Загружаем ключи из .env
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

SHARE_DIR="/home/rgubarev/www_share"

# Удаляет старые версии из SHARE_DIR по паттерну, оставляя указанный файл
# Аргументы: $1 — glob-паттерн (например "r-helper-*.xpi"), $2 — файл текущей версии
cleanup_old_versions() {
    local pattern="$1" current="$2" found=false
    for f in "$SHARE_DIR"/$pattern; do
        [ -f "$f" ] || continue
        [ "$(basename "$f")" = "$current" ] && continue
        rm -f "$f"
        echo "  Удалён: $(basename "$f")"
        found=true
    done
    if ! $found; then
        echo "  Старых версий не найдено"
    fi
}

# --- Firefox (AMO) ---
publish_firefox() {
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo "ПРЕДУПРЕЖДЕНИЕ: AMO_JWT_ISSUER и/или AMO_JWT_SECRET не заданы (проверь .env)"
        return 1
    fi

    echo "Публикация на AMO..."

    # Проверяем текущую версию на AMO
    echo "  Проверка текущей версии на AMO..."
    local amo_response amo_version
    amo_response=$(curl -s "https://addons.mozilla.org/api/v5/addons/addon/r-helper/" 2>/dev/null || echo "")
    amo_version=$(echo "$amo_response" | grep -o '"version":"[^"]*"' | head -1 | sed 's/"version":"\([^"]*\)"/\1/')

    if [ "$amo_version" = "$VERSION" ]; then
        echo "Firefox: версия $VERSION уже опубликована на AMO, пропускаю"
        return 0
    fi
    echo "  AMO: v${amo_version:-?}, загружаем v${VERSION}..."

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

download_xpi() {
    local XPI_DEST_DIR="$SHARE_DIR"
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
            cleanup_old_versions "r[_-]helper-*.xpi" "$XPI_FILENAME"
            ls -lh "$XPI_DEST_DIR/$XPI_FILENAME"
        else
            echo "ОШИБКА: не удалось скачать .xpi"
        fi
    else
        echo "Не удалось получить ссылку на .xpi (возможно, версия ещё на модерации)"
    fi
}

if $DO_FIREFOX; then
    while true; do
        if publish_firefox; then
            download_xpi
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

    # 2. Проверяем черновик — если эта версия уже загружена, пропускаем upload
    echo "  Проверка текущего черновика..."
    DRAFT_RESPONSE=$(curl -s \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "x-goog-api-version: 2" \
        "https://www.googleapis.com/chromewebstore/v1.1/items/$CHROME_EXTENSION_ID?projection=DRAFT")

    DRAFT_VERSION=$(echo "$DRAFT_RESPONSE" | grep -o '"crxVersion" *: *"[^"]*"' | sed 's/"crxVersion" *: *"\([^"]*\)"/\1/')

    echo "  Черновик: v${DRAFT_VERSION:-?}"

    # Загружаем если версия не совпадает
    if [ "$DRAFT_VERSION" != "$VERSION" ]; then
        echo "  Загрузка $CHROME_ZIP..."
        UPLOAD_RESPONSE=$(curl -s \
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
    else
        echo "  Версия $VERSION уже загружена, пропускаю upload"
    fi

    # 3. Публикуем
    echo "  Публикация..."
    PUBLISH_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "x-goog-api-version: 2" \
        -H "Content-Length: 0" \
        "https://www.googleapis.com/chromewebstore/v1.1/items/$CHROME_EXTENSION_ID/publish")

    PUBLISH_STATUS=$(echo "$PUBLISH_RESPONSE" | grep -o '"status" *: *\[[^]]*\]' | grep -o '"[A-Z_]*"' | head -1 | tr -d '"')

    if echo "$PUBLISH_RESPONSE" | grep -q "item that is in review"; then
        echo "Chrome: версия $VERSION уже на проверке в CWS"
        return 0
    fi

    if [ "$PUBLISH_STATUS" != "OK" ] && [ "$PUBLISH_STATUS" != "PUBLISHED_WITH_FRICTION_WARNING" ]; then
        echo "ОШИБКА: публикация не удалась (status=$PUBLISH_STATUS)"
        echo "Ответ: $PUBLISH_RESPONSE"
        return 1
    fi

    echo "Chrome: версия $VERSION опубликована в Chrome Web Store (status=$PUBLISH_STATUS)"
}

if $DO_CHROME; then
    echo ""
    while true; do
        if publish_chrome; then
            # Копируем zip в www_share
            SHARE_DIR="/home/rgubarev/www_share"
            if [ -d "$SHARE_DIR" ]; then
                cp "$CHROME_ZIP" "$SHARE_DIR/$CHROME_ZIP"
                echo "Скопировано: $SHARE_DIR/$CHROME_ZIP"
                cleanup_old_versions "${EXTENSION_NAME}-*-chrome.zip" "$CHROME_ZIP"
            fi
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
fi

echo ""
echo "Готово!"
