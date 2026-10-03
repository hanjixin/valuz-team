#!/usr/bin/env bash
# Canonical dev launcher: local PostgreSQL + Redis, then the server in watch mode.
#   ./scripts/dev.sh            server (starts the infra if needed)
#   ./scripts/dev.sh infra      infra only
#   ./scripts/dev.sh down       stop the infra (data is kept)
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -f deploy/docker-compose.dev.yml)

case "${1:-server}" in
  down) "${compose[@]}" down ;;
  infra) "${compose[@]}" up -d --wait ;;
  server)
    "${compose[@]}" up -d --wait
    export DATABASE_URL="${DATABASE_URL:-postgres://agentbase:agentbase@127.0.0.1:55432/agentbase}"
    export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:56379/0}"
    exec pnpm --filter @agent-base/server dev
    ;;
  *) echo "usage: $0 [server|infra|down]" >&2; exit 2 ;;
esac
