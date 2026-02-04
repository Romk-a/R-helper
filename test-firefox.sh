#!/bin/bash
# test-firefox.sh — Тестирование расширения в Firefox
#
# Что делает:
#   Запускает Firefox с временно загруженным расширением через web-ext run.
#   Расширение работает без подписи, пока Firefox запущен через этот скрипт.
#
# Требования:
#   - Собранный пакет (сначала запусти ./pack.sh)
#   - Node.js + npm (для web-ext)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

EXTENSION_NAME="r-helper"
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')
FIREFOX_OUTPUT="${EXTENSION_NAME}-${VERSION}-firefox.zip"

if [ ! -f "$FIREFOX_OUTPUT" ]; then
    echo "ОШИБКА: Пакет не найден. Сначала запусти ./pack.sh"
    echo "Ожидаемый файл: $FIREFOX_OUTPUT"
    exit 1
fi

echo "Запуск Firefox с расширением $FIREFOX_OUTPUT..."
echo "Для завершения закрой Firefox или нажми Ctrl+C"
echo ""

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

unzip -q "$FIREFOX_OUTPUT" -d "$TMPDIR/firefox"

npx --yes web-ext run \
    --source-dir="$TMPDIR/firefox" \
    --firefox=firefox \
    --browser-console \
    --no-reload
