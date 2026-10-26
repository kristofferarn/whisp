#!/bin/bash
# Builds whisp.app from the SwiftPM package and signs it.
#
#   scripts/build.sh            debug build → build/whisp dev.app (own data, own permissions)
#   scripts/build.sh release    release build → build/whisp.app
#   scripts/build.sh release --install   …and copy it to /Applications
#
# Signing: macOS ties Accessibility, Input Monitoring and Microphone grants to
# the app's signature. Ad-hoc signatures change on every build, so every
# rebuild would ask for them again. A self-signed code-signing certificate
# named "whisp Dev" (see README) keeps the signature stable; WHISP_SIGN_IDENTITY
# overrides the name. Without one the build falls back to ad-hoc and says so.
set -euo pipefail
cd "$(dirname "$0")/.."

config=${1:-debug}
install=${2:-}
version=1.0.0
build=$(git rev-list --count HEAD 2>/dev/null || echo 1)

if [[ $config == release ]]; then
  name=whisp
  bundle_id=com.kristofferarn.whisp
else
  config=debug
  name="whisp dev"
  bundle_id=com.kristofferarn.whisp.dev
fi

swift build -c "$config" --product Whisp
bin=$(swift build -c "$config" --show-bin-path)/Whisp

app="build/$name.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/Whisp"
cp Resources/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
sed -e "s/__BUNDLE_ID__/$bundle_id/" \
    -e "s/__NAME__/$name/" \
    -e "s/__VERSION__/$version/" \
    -e "s/__BUILD__/$build/" \
    Resources/Info.plist > "$app/Contents/Info.plist"

identity=${WHISP_SIGN_IDENTITY:-whisp Dev}
if ! security find-identity -p codesigning | grep -q "\"$identity\""; then
  echo "note: no \"$identity\" signing certificate — signing ad-hoc. Fine for scripts/run.sh (the terminal's permissions apply); an installed copy would ask for permissions again after each update" >&2
  identity=-
fi
codesign --force --options runtime --timestamp=none \
  --entitlements Resources/whisp.entitlements \
  --sign "$identity" "$app"

echo "built $app"

if [[ $install == --install ]]; then
  rm -rf "/Applications/$name.app"
  cp -R "$app" /Applications/
  echo "installed /Applications/$name.app"
fi
