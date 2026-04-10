#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="$ROOT/chaya-engine"
CONFIG_FILE="$ENGINE_DIR/config/config.yaml"
PORT="${PORT:-3002}"
HOST="0.0.0.0"
LOG_FILE="$ENGINE_DIR/chaya-engine.log"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "[restart-engine] config not found: $CONFIG_FILE" >&2
  exit 1
fi

tmp_file="$(mktemp)"
awk '
  /^server:/ { in_server=1; print; next }
  in_server && /^[^[:space:]]/ { in_server=0 }
  in_server && /^[[:space:]]*host:[[:space:]]*/ { $0="  host: 0.0.0.0" }
  { print }
' "$CONFIG_FILE" > "$tmp_file"
mv "$tmp_file" "$CONFIG_FILE"

echo "[restart-engine] server.host forced to 0.0.0.0"
echo "[restart-engine] stopping process on port $PORT ..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
sleep 1

echo "[restart-engine] starting chaya-engine on $HOST:$PORT ..."
cd "$ENGINE_DIR"
nohup go run ./cmd/server/ > "$LOG_FILE" 2>&1 &
PID=$!

sleep 1
if ! kill -0 "$PID" 2>/dev/null; then
  echo "[restart-engine] failed to start. recent logs:" >&2
  if [[ -f "$LOG_FILE" ]]; then
    cat "$LOG_FILE" >&2
  fi
  exit 1
fi

echo "[restart-engine] started"
echo "[restart-engine] pid: $PID"
echo "[restart-engine] server: http://$HOST:$PORT"
echo "[restart-engine] log: $LOG_FILE"
