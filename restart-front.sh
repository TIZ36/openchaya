#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONT_DIR="$ROOT/chaya-front"
PORT="${PORT:-5177}"
LOG_FILE="$FRONT_DIR/chaya-front.log"

if [[ ! -d "$FRONT_DIR" ]]; then
  echo "[restart-front] front dir not found: $FRONT_DIR" >&2
  exit 1
fi

echo "[restart-front] stopping process on port $PORT ..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
sleep 1

echo "[restart-front] starting frontend on 0.0.0.0:$PORT ..."
cd "$FRONT_DIR"
nohup pnpm dev > "$LOG_FILE" 2>&1 &
PID=$!

sleep 2
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[restart-front] failed to start. logs:" >&2
  if [[ -f "$LOG_FILE" ]]; then
    cat "$LOG_FILE" >&2
  fi
  exit 1
fi

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi

echo "[restart-front] started"
echo "[restart-front] pid: $PID"
echo "[restart-front] local: http://localhost:$PORT"
if [[ -n "$LAN_IP" ]]; then
  echo "[restart-front] lan:   http://$LAN_IP:$PORT"
fi
echo "[restart-front] log:   $LOG_FILE"
