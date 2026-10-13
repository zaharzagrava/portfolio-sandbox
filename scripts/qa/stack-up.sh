#!/usr/bin/env bash
# A brand-new dev stack (own compose project, empty volumes) plus the API, for the scripted buy flow, the QA agent and fresh-run.sh.
#   scripts/qa/stack-up.sh        prints "QA_DIR=<dir>" when the API is ready; scripts/qa/stack-down.sh <dir> removes everything of it
# Refuses to run while the developer's own dev stack is up (same ports and container names). Takes about 4 minutes.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
if [[ -n "$(docker ps -q --filter name=payment_system_)" ]]; then
  echo "the dev stack is running (containers payment_system_*): stop it first, then run this again" >&2; exit 2
fi
QA_DIR="${QA_DIR:-$(mktemp -d)}"; P="sddqa$(date +%H%M%S)"
echo "$P" > "$QA_DIR/project"
docker compose -f docker-compose.test.yaml -p marketplace_test stop >/dev/null 2>&1   # the test and dev stacks cannot both run on one laptop (Scylla)
stale="$(docker ps -a -q --filter name=payment_system_)"; [[ -n "$stale" ]] && docker rm $stale >/dev/null
[[ -f packages/backend/.env ]] || bash scripts/infra/make-dev-env.sh >/dev/null
# own session, so that stack-down can stop the whole group
COMPOSE_PROJECT_NAME="$P" setsid scripts/infra/stack.sh dev setup >"$QA_DIR/stack.log" 2>&1 & echo $! > "$QA_DIR/stack.pid"
for _ in $(seq 1 180); do grep -q "dev stack is up and migrated" "$QA_DIR/stack.log" && break; kill -0 "$(cat "$QA_DIR/stack.pid")" 2>/dev/null || break; sleep 5; done
grep -q "dev stack is up and migrated" "$QA_DIR/stack.log" || { echo "the stack did not come up: see $QA_DIR/stack.log" >&2; "$(dirname "$0")/stack-down.sh" "$QA_DIR"; exit 1; }
[[ -n "${NO_API:-}" ]] && { echo "QA_DIR=$QA_DIR"; exit 0; }   # NO_API=1: only the stack (scripts/infra/boot-check.sh starts and judges the API)
setsid pnpm --filter api run start:dev:monolith >"$QA_DIR/api.log" 2>&1 & echo $! > "$QA_DIR/api.pid"
for _ in $(seq 1 120); do curl -sf localhost:8000/health/ready >/dev/null && break; sleep 5; done
curl -sf localhost:8000/health/ready >/dev/null || { echo "the API did not become ready: see $QA_DIR/api.log" >&2; "$(dirname "$0")/stack-down.sh" "$QA_DIR"; exit 1; }
# the seeded accounts and products (a fresh stack has none)
pnpm --filter api seed:dev >"$QA_DIR/seed.log" 2>&1 || { echo "the seed failed: see $QA_DIR/seed.log" >&2; "$(dirname "$0")/stack-down.sh" "$QA_DIR"; exit 1; }
if [[ "${WITH_WEB:-}" == 1 ]]; then   # the storefront, for the browser (QA agent, Playwright)
  (cd packages/web && NEXT_PUBLIC_PAYMENTS_SANDBOX=true setsid pnpm run dev >"$QA_DIR/web.log" 2>&1 & echo $! > "$QA_DIR/web.pid")
  for _ in $(seq 1 60); do curl -sf localhost:3000 >/dev/null && break; sleep 3; done
  curl -sf localhost:3000 >/dev/null || { echo "the web server did not answer: see $QA_DIR/web.log" >&2; "$(dirname "$0")/stack-down.sh" "$QA_DIR"; exit 1; }
fi
echo "QA_DIR=$QA_DIR"
