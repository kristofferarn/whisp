#!/bin/bash
# Derives Resources/AppIcon.icns from Resources/logo.png. Run after the logo
# changes; the .icns is committed so a normal build never needs this.
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
set=$work/AppIcon.iconset
mkdir "$set"
for size in 16 32 128 256 512; do
  sips -z $size $size Resources/logo.png --out "$set/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double Resources/logo.png --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set" -o Resources/AppIcon.icns
rm -rf "$work"
echo "wrote Resources/AppIcon.icns"
