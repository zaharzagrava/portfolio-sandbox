#!/usr/bin/env bash
# What a new machine sees: a brand-new dev stack (its own compose project, so empty volumes), the API, the WHOLE browser suite once, then everything
# of that run is removed. Most of the failures of 2026-10-12 were reproducible only like this, not on a stack that had been running for a while.
#
#   scripts/qa/fresh-run.sh [playwright arguments]       e.g. scripts/qa/fresh-run.sh tests/chat.spec.ts
#
# It needs the ports and container names of the dev stack, so it REFUSES to run while that stack is up (stop it first). Your own volumes are never touched:
# only the throwaway project's are removed. Takes about 8 minutes. Logs: $LOG_DIR (default: a temp directory, printed at the end).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
if [[ -n "$(docker ps -q --filter name=payment_system_)" ]]; then
  echo "the dev stack is running (containers payment_system_*): stop it first (Ctrl+C in the terminal that runs infra-setup), then run this again" >&2
  exit 2
fi
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"; P="sddfresh$(date +%H%M%S)"
echo "== throwaway project $P, logs in $LOG_DIR"
# frees Scylla's memory settings (the test and dev stacks cannot both run on one laptop) and stopped containers whose names this stack needs
docker compose -f docker-compose.test.yaml -p marketplace_test stop >/dev/null 2>&1
stale="$(docker ps -a -q --filter name=payment_system_)"; [[ -n "$stale" ]] && { echo "removing stopped containers with the dev stack's names (their volumes stay)"; docker rm $stale >/dev/null; }
[[ -f packages/backend/.env ]] || bash scripts/infra/make-dev-env.sh >/dev/null

COMPOSE_PROJECT_NAME="$P" scripts/infra/stack.sh dev setup >"$LOG_DIR/stack.log" 2>&1 & STACK=$!
for _ in $(seq 1 180); do grep -q "dev stack is up and migrated" "$LOG_DIR/stack.log" && break; kill -0 "$STACK" 2>/dev/null || break; sleep 5; done
grep -q "dev stack is up and migrated" "$LOG_DIR/stack.log" || { echo "the stack did not come up: see $LOG_DIR/stack.log" >&2; kill -INT "$STACK" 2>/dev/null; exit 1; }
pnpm --filter api run start:dev:monolith >"$LOG_DIR/api.log" 2>&1 & API=$!
for _ in $(seq 1 120); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 5; done
curl -sf localhost:8000/health/ready >/dev/null || echo "WARNING: the API did not become ready: see $LOG_DIR/api.log" >&2

(cd packages/web && PW_EXPECT_TIMEOUT_MS="${PW_EXPECT_TIMEOUT_MS:-20000}" API_URL=http://localhost:8000 pnpm exec playwright test --workers=2 --reporter=list "$@") 2>&1 | tee "$LOG_DIR/playwright.log" | tail -n 25
rc=${PIPESTATUS[0]}

kill "$API" 2>/dev/null; kill -INT "$STACK" 2>/dev/null; sleep 20
COMPOSE_PROJECT_NAME="$P" docker compose -f docker-compose.yaml --env-file packages/backend/.env down -v >/dev/null 2>&1
echo "== playwright exit $rc; logs: $LOG_DIR"
exit "$rc"
