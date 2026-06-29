#!/usr/bin/env bash
# Shared helpers for the restart-*.sh dev scripts. Source, don't execute:
#   ROOT="$(cd "$(dirname "$0")" && pwd)"; source "$ROOT/scripts/_lib.sh"
# Set TAG (e.g. "[restart-front]") before calling log/err for prefixed output.

TAG="${TAG:-}"

log() { echo "${TAG:+$TAG }$*"; }
err() { echo "${TAG:+$TAG }$*" >&2; }
die() { err "$*"; exit 1; }

# kill_port PORT — kill anything listening on PORT (no-op if nothing matches).
kill_port() {
  local port="$1" pids
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  [[ -n "$pids" ]] && echo "$pids" | xargs kill -9 2>/dev/null || true
}

# lan_ip — first LAN IPv4 (en0 then en1); empty if none.
lan_ip() {
  ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true
}

# start_bg LOG CMD... — run CMD detached to LOG, verify it survives 2s.
# Sets global START_PID; dumps the log and exits 1 on early death.
start_bg() {
  local log="$1"; shift
  nohup "$@" > "$log" 2>&1 &
  START_PID=$!
  sleep 2
  if ! kill -0 "$START_PID" 2>/dev/null; then
    err "failed to start. logs:"
    [[ -f "$log" ]] && cat "$log" >&2
    exit 1
  fi
}
