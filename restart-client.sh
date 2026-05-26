#!/bin/bash
# chaya-front restart script — kills Vite (5177) + Electron, then restarts.
# Usage (run from chaya-next/):
#   ./restart-client.sh           # restart electron + vite (default)
#   ./restart-client.sh web       # just vite (browser only)
#   ./restart-client.sh kill      # only kill, don't restart

set -u
cd "$(dirname "$0")/chaya-front"

VITE_PORT=5177
MODE="${1:-electron}"
LOG_DIR=".logs"
mkdir -p "$LOG_DIR"

echo "Stopping Vite on port $VITE_PORT..."
lsof -ti:$VITE_PORT 2>/dev/null | xargs kill -9 2>/dev/null || true

echo "Stopping Electron (Chaya / chaya-front)..."
pkill -f "electron .*chaya-front" 2>/dev/null || true
pkill -f "Electron Helper.*chaya-front" 2>/dev/null || true
pkill -f "$(pwd)/node_modules/electron" 2>/dev/null || true

pkill -f "concurrently.*chaya-front" 2>/dev/null || true
pkill -f "wait-on tcp:$VITE_PORT" 2>/dev/null || true

sleep 1
echo "✅ Cleaned"
echo ""

if [ "$MODE" = "kill" ]; then
  exit 0
fi

if [ "$MODE" = "web" ]; then
  echo "Starting Vite (browser only) — open http://localhost:$VITE_PORT/v2"
  echo "========================================================="
  exec pnpm dev
fi

echo "Starting Electron + Vite (mode: $MODE)"
echo "Logs:  tail -f chaya-front/$LOG_DIR/electron.log"
echo "Open:  Electron window will auto-load; navigate to /v2 for new shell"
echo "========================================================="
exec pnpm electron:dev 2>&1 | tee "$LOG_DIR/electron.log"
