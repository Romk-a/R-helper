#!/bin/bash
# Упаковка расширения R-Helper в ZIP для Chrome Web Store

set -e

EXTENSION_NAME="r-helper"
VERSION=$(grep '"version"' manifest.json | sed 's/.*: *"\(.*\)".*/\1/')
OUTPUT="${EXTENSION_NAME}-${VERSION}.zip"

# Удалить старый архив, если есть
rm -f "$OUTPUT"

# Создать ZIP только с нужными файлами
zip -r "$OUTPUT" \
    manifest.json \
    background.js \
    content.js \
    content.css \
    popup.html \
    popup.js \
    popup.css \
    icons/

echo "Создан архив: $OUTPUT"
echo "Содержимое:"
unzip -l "$OUTPUT"
