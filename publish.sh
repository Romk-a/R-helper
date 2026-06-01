#!/bin/bash
# publish.sh — Публикация расширения R-Helper
#
# Что делает:
#   1. Проверяет наличие собранных пакетов
#   2. Загружает и публикует Chrome-версию в Chrome Web Store
#   3. Загружает Firefox-версию на AMO через web-ext sign
#   4. Скачивает подписанный .xpi с AMO
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

# --- AMO API (авторизованные запросы по JWT) ---
# Публичный API (/addons/addon/r-helper/) показывает только последнюю
# ОДОБРЕННУЮ версию и сильно отстаёт, пока новая версия на модерации.
# Поэтому проверку «есть ли уже такая версия» и поиск .xpi делаем через
# авторизованный эндпоинт /versions/, который видит все версии сразу.
AMO_SLUG="r-helper"
AMO_API_BASE="https://addons.mozilla.org/api/v5"

# Генерирует короткоживущий (180с) JWT для AMO API
amo_jwt() {
    local now exp jti header payload h p sig
    now=$(date +%s); exp=$((now + 180))
    jti=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    header='{"alg":"HS256","typ":"JWT"}'
    payload=$(printf '{"iss":"%s","jti":"%s","iat":%s,"exp":%s}' "$AMO_JWT_ISSUER" "$jti" "$now" "$exp")
    h=$(printf '%s' "$header"  | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
    p=$(printf '%s' "$payload" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
    sig=$(printf '%s' "$h.$p" | openssl dgst -sha256 -hmac "$AMO_JWT_SECRET" -binary | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
    printf '%s.%s.%s' "$h" "$p" "$sig"
}

# GET к AMO API с авторизацией. $1 — путь начиная с /addons/...
amo_api() {
    curl -s -H "Authorization: JWT $(amo_jwt)" "$AMO_API_BASE$1"
}

# Возвращает JSON-объект версии $VERSION (любой канал/статус), либо пусто
amo_version_json() {
    amo_api "/addons/addon/$AMO_SLUG/versions/?filter=all_with_unlisted" \
        | jq -c --arg v "$VERSION" '(.results // [])[] | select(.version == $v)' 2>/dev/null
}

# --- Firefox (AMO) ---
publish_firefox() {
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo "ПРЕДУПРЕЖДЕНИЕ: AMO_JWT_ISSUER и/или AMO_JWT_SECRET не заданы (проверь .env)"
        return 1
    fi

    echo "Публикация на AMO..."

    # Проверяем ВСЕ версии (включая те, что на модерации)
    echo "  Проверка версии $VERSION на AMO..."
    if [ -n "$(amo_version_json)" ]; then
        echo "Firefox: версия $VERSION уже загружена на AMO, пропускаю sign"
        return 0
    fi

    # Распаковываем zip во временную папку для web-ext
    local tmpdir
    tmpdir=$(mktemp -d)
    trap 'rm -rf "$tmpdir"' RETURN

    unzip -q "$FIREFOX_OUTPUT" -d "$tmpdir/firefox"

    # Ловим вывод web-ext: если предпроверка не сработала и AMO вернёт
    # конфликт «версия уже существует» — считаем это успехом, не ошибкой.
    local log="$tmpdir/sign.log" rc
    set +e; set -o pipefail
    npx --yes web-ext sign \
        --source-dir="$tmpdir/firefox" \
        --artifacts-dir="$tmpdir/artifacts" \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=listed 2>&1 | tee "$log"
    rc=$?
    set +o pipefail; set -e

    if [ $rc -ne 0 ]; then
        if grep -qiE "already exists|Conflict" "$log"; then
            echo "Firefox: версия $VERSION уже существует на AMO — считаю загруженной"
            return 0
        fi
        echo "ОШИБКА: web-ext sign завершился с ошибкой"
        return 1
    fi

    echo "Firefox: версия $VERSION загружена на AMO (ожидает проверки)"
}

download_xpi() {
    if [ -z "$SHARE_DIR" ]; then
        echo "SHARE_DIR не задан, пропускаю копирование .xpi"
        return 0
    fi

    local timeout="${XPI_TIMEOUT:-240}" start now elapsed vjson url status
    start=$(date +%s)

    echo ""
    echo "Ожидание подписанного .xpi на AMO (таймаут ${timeout}с)..."

    url=""
    while true; do
        vjson=$(amo_version_json)
        if [ -n "$vjson" ]; then
            url=$(echo "$vjson"    | jq -r '.file.url    // empty')
            status=$(echo "$vjson" | jq -r '.file.status // "?"')
            if [ -n "$url" ]; then
                echo "Найден файл версии $VERSION на AMO (статус: $status)"
                break
            fi
        fi

        now=$(date +%s); elapsed=$((now - start))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo "Файл версии $VERSION ещё не подписан (вероятно, на модерации)."
            echo "Это не ошибка — запусти ./publish.sh --firefox позже, он докачает .xpi."
            return 0
        fi
        sleep 5
    done

    local fname="${EXTENSION_NAME}-${VERSION}.xpi" dest="$SHARE_DIR/${EXTENSION_NAME}-${VERSION}.xpi"
    echo "Скачивание: $url"
    if curl -fsSL --max-time 60 -o "$dest" "$url"; then
        echo "Сохранено: $dest"
        cleanup_old_versions "r[_-]helper-*.xpi" "$fname"
        ln -sf "$fname" "$SHARE_DIR/r-helper-latest.xpi"
        echo "Ссылка: $SHARE_DIR/r-helper-latest.xpi -> $fname"
        ls -lh "$dest"
    else
        echo "ОШИБКА: не удалось скачать .xpi ($url)"
    fi
}

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

    PUBLISH_STATUS=$(echo "$PUBLISH_RESPONSE" | tr -d '\n' | grep -o '"status" *: *\[[^]]*\]' | grep -o '"[A-Z_]*"' | head -1 | tr -d '"')

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
            if [ -n "$SHARE_DIR" ] && [ -d "$SHARE_DIR" ]; then
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

if $DO_FIREFOX; then
    echo ""
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

echo ""
echo "Готово!"
