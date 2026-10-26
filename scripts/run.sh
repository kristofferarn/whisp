#!/bin/bash
# Builds the dev app and (re)launches it. Logs stream to this terminal.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/build.sh debug
pkill -f "whisp dev.app/Contents/MacOS/Whisp" 2>/dev/null || true
exec "build/whisp dev.app/Contents/MacOS/Whisp" "$@"
