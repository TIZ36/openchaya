#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/app"

LOG_DIR=".logs"
mkdir -p "$LOG_DIR"

echo "Stopping Electron app..."
pkill -f "electron .*app" 2>/dev/null || true
pkill -f "Electron Helper.*app" 2>/dev/null || true
pkill -f "$(pwd)/node_modules/electron" 2>/dev/null || true
pkill -f "concurrently.*app" 2>/dev/null || true
pkill -f "wait-on tcp:5177" 2>/dev/null || true
sleep 1

echo "Starting Electron app..."
exec pnpm electron:dev 2>&1 | tee "$LOG_DIR/electron.log"
