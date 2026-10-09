#!/usr/bin/env bash
# Docker stacks, always in the foreground (never `-d`): Ctrl+C stops everything.
#
#   scripts/infra/stack.sh <dev|test> <up|reup|setup|resetup>
#
#   up       start the stack
#   reup     run `pnpm infra-clean` first, then start it (clean slate)
#   setup    start the stack, and once it answers run the migrations (still foreground)
#   resetup  reup + setup
#
# reup/resetup clean up with the root `pnpm infra-clean`, which is machine-wide: it removes every container
# (not just this project's) and prunes unused volumes and networks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

env_name="${1:-}"; mode="${2:-}"
case "$env_name" in
  dev)  COMPOSE=(docker compose --env-file packages/backend/.env)
        UP_ARGS=(--build); MIGRATE=(pnpm --filter api run infra:setup); TRIES=60 ;;
  test) COMPOSE=(docker compose -f docker-compose.test.yaml -p marketplace_test)
        UP_ARGS=();        MIGRATE=(pnpm --filter api run db:jest:migrate:up); TRIES=40 ;;
  *) echo "usage: $0 <dev|test> <up|reup|setup|resetup>" >&2; exit 2 ;;
esac

# The root `pnpm infra-clean`: stops and removes EVERY container on the machine, prunes volumes and networks.
reset() { echo "→ pnpm infra-clean"; pnpm infra-clean; }

case "$mode" in
  up)      exec "${COMPOSE[@]}" up "${UP_ARGS[@]}" ;;
  reup)    reset; exec "${COMPOSE[@]}" up "${UP_ARGS[@]}" ;;
  setup|resetup)
    [ "$mode" = resetup ] && reset
    # Background job only so the migrations can run next to it; its logs still stream to this terminal.
    "${COMPOSE[@]}" up "${UP_ARGS[@]}" &
    stack=$!
    trap 'kill -INT "$stack" 2>/dev/null || true; wait "$stack" 2>/dev/null || true; exit 130' INT TERM
    for i in $(seq 1 "$TRIES"); do
      kill -0 "$stack" 2>/dev/null || { echo "→ the stack exited before the migrations ran" >&2; exit 1; }
      sleep 5
      if "${MIGRATE[@]}"; then
        echo "→ $env_name stack is up and migrated. Ctrl+C stops it."
        wait "$stack"; exit $?
      fi
      echo "→ stores not ready yet (attempt $i/$TRIES), retrying in 5s"
    done
    echo "→ migrations never succeeded; stopping the stack" >&2
    kill -INT "$stack" 2>/dev/null || true; wait "$stack" 2>/dev/null || true; exit 1 ;;
  *) echo "usage: $0 <dev|test> <up|reup|setup|resetup>" >&2; exit 2 ;;
esac
