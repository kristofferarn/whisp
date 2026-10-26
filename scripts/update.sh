#!/bin/bash
# Updates the installed whisp in one go: pull the latest code, build it,
# quit the running copy, install the new one and open it again.
#
#   scripts/update.sh            pull, then build and install
#   scripts/update.sh --no-pull  build and install what's checked out now
#
# The pull is fast-forward only, so local commits or a diverged branch stop
# the update instead of producing a merge. The running whisp is quit only
# after the build succeeds, so a broken build never leaves you without it.
set -euo pipefail
cd "$(dirname "$0")/.."

app=/Applications/whisp.app
binary="$app/Contents/MacOS/Whisp"

if [[ ${1:-} != --no-pull ]]; then
  echo "pulling…"
  git pull --ff-only
fi

scripts/build.sh release

if pgrep -f "$binary" >/dev/null; then
  echo "quitting whisp…"
  pkill -f "$binary" || true
  for _ in {1..50}; do
    pgrep -f "$binary" >/dev/null || break
    sleep 0.1
  done
fi

rm -rf "$app"
cp -R build/whisp.app "$app"
echo "installed $app"

open "$app"
echo "whisp is running ($(git log -1 --format='%h %s'))"
