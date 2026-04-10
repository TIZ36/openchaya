#!/usr/bin/env bash
# 重启 chaya-next 的 Docker Compose 服务（默认仅 PostgreSQL；加 --ml 同时拉起 chaya-ml）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PROFILE_ARGS=()
if [[ "${1:-}" == "--ml" ]]; then
  PROFILE_ARGS=(--profile ml)
fi

echo "[restart-docker] compose down …"
docker compose "${PROFILE_ARGS[@]}" down

echo "[restart-docker] compose up -d …"
docker compose "${PROFILE_ARGS[@]}" up -d

echo "[restart-docker] done."
docker compose "${PROFILE_ARGS[@]}" ps
