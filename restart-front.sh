#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
source "$ROOT/scripts/_lib.sh"
TAG="[restart-front]"

FRONT_DIR="$ROOT/app"
PORT="${PORT:-5177}"
LOG_FILE="$FRONT_DIR/app.log"

[[ -d "$FRONT_DIR" ]] || die "front dir not found: $FRONT_DIR"

log "stopping process on port $PORT ..."
kill_port "$PORT"
sleep 1

log "starting frontend on 0.0.0.0:$PORT ..."
cd "$FRONT_DIR"
start_bg "$LOG_FILE" pnpm dev

log "started"
log "pid:   $START_PID"
log "local: http://localhost:$PORT"
ip="$(lan_ip)"; [[ -n "$ip" ]] && log "lan:   http://$ip:$PORT"
log "log:   $LOG_FILE"
