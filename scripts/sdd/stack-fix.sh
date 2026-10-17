#!/usr/bin/env bash
# Checks and remedies for the local DEV stack that web and journey gates run against. One command the repair agent may run
# (a compound shell line with a login inside would not match its allow-list).
#
#   scripts/sdd/stack-fix.sh smoke     API ready, product search answers 200, Playwright's Chromium installed; says what to run if not
#   scripts/sdd/stack-fix.sh api-restart  restart the dev API from the current start script and environment, then wait for it
#   scripts/sdd/stack-fix.sh api-ready  wait until the watch-mode API has finished recompiling and answers ready steadily
#   scripts/sdd/stack-fix.sh journey   (re)start the document-extractor stand-in on fresh code and check the metrics port; the journey gate runs it first
#   scripts/sdd/stack-fix.sh browser   install Playwright's Chromium for the version packages/web uses
#   scripts/sdd/stack-fix.sh reindex   rebuild the product search index from the database (as the seeded admin) and wait for documents
#
# Shared state that other tests change (the trending ranking, carts, counters) cannot be cleaned from outside: it is rebuilt from stores a
# test cannot clear. A test that needs a known state creates its own data (its own product in its own category) instead.
#
# Environment faults (a 503 from search, a missing browser, an empty index) are not code faults: fix them here, do not edit tests or
# product code to get around them, and write what you did in the spec's gaps.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@marketplace.local}"; ADMIN_PASSWORD="${ADMIN_PASSWORD:-Demo-Seed-Pw-7491!}"   # scripts/seed/dev-seed.ts

browser_ok() { (cd "$ROOT/packages/web" && node -e "const {chromium}=require('@playwright/test');process.exit(require('fs').existsSync(chromium.executablePath())?0:1)" 2>/dev/null); }

case "${1:-}" in
  smoke)
    bad=0
    code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$API_URL/health/ready")"
    if [[ "$code" != 200 ]]; then echo "ENVIRONMENT: the API is not ready ($API_URL/health/ready answered $code). Start it (pnpm --filter api run start:dev:monolith) and read its log."; bad=1; fi
    if [[ "$code" == 200 ]]; then
      code="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$API_URL/api/products/search?limit=1")"
      if [[ "$code" != 200 ]]; then echo "ENVIRONMENT: product search answered $code (503 search_unavailable usually means the index has a stale mapping). Run: bash scripts/sdd/stack-fix.sh reindex"; bad=1; fi
    fi
    if ! browser_ok; then echo "ENVIRONMENT: Playwright's Chromium is not installed for this version. Run: bash scripts/sdd/stack-fix.sh browser"; bad=1; fi
    (( bad == 0 )) && echo "environment ok: API ready, search answers 200, Chromium installed"
    exit "$bad" ;;
  api-restart)
    # Restarts the dev API (the nest watcher and the process it started) from the current start script and environment, and waits until it is
    # stable. Agents are not allowed to run `kill` or the start script themselves; this is the one command for it.
    pkill -TERM -f 'nest start local-monolith' 2>/dev/null; pkill -TERM -f 'dist/apps/local-monolith/main' 2>/dev/null; sleep 4
    pkill -KILL -f 'nest start local-monolith' 2>/dev/null; pkill -KILL -f 'dist/apps/local-monolith/main' 2>/dev/null; sleep 1
    (cd "$ROOT" && setsid nohup pnpm --filter api run start:dev:monolith >>"${API_LOG:-/tmp/sdd-api.log}" 2>&1 < /dev/null &)
    sleep 5
    API_READY_WAIT_S=420 exec bash "$0" api-ready ;;
  api-ready)
    # The dev API runs in watch mode: every edit of backend code recompiles and restarts it, and for a few seconds the BFF answers 502/503.
    # A browser or journey spec that starts in that window fails for no reason of its own. Wait until the API has answered ready five times in
    # a row (10 s) and its log has been quiet for 6 s (no restart under way). At the deadline a ready API is accepted even if its log is busy.
    deadline=$((SECONDS + ${API_READY_WAIT_S:-240})); streak=0
    while (( SECONDS < deadline )); do
      if [[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API_URL/health/ready")" == 200 ]]; then streak=$((streak + 1)); else streak=0; fi
      quiet=1; if [[ -n "${API_LOG:-}" && -f "$API_LOG" ]]; then (( $(date +%s) - $(stat -c %Y "$API_LOG") >= 6 )) || quiet=0; fi
      (( streak >= 5 && quiet )) && { echo "API stable (ready 5 times in a row, log quiet)"; exit 0; }
      sleep 2
    done
    (( streak >= 5 )) && { echo "API ready, log still busy after ${API_READY_WAIT_S:-240}s: going on"; exit 0; }
    echo "ENVIRONMENT: the API is not stable after ${API_READY_WAIT_S:-240}s (it keeps restarting or answers errors). Read /var/log/sdd/api.log for the cause."; exit 1 ;;
  standins)
    # The local stand-ins for the Lambdas nothing else consumes: document-extractor (without it no shop is ever verified: J01 AS-29,
    # shop verification) and media-processing (without it a photo stays "Waiting to process": W04 seller-photos). The runner did not start
    # them, so the first web gate on a fresh machine failed 17 specs. Starts them when missing; `journey` below rebuilds and restarts them.
    if pgrep -f 'lambda-local/main.js' >/dev/null; then echo "stand-ins already running"; exit 0; fi
    exec bash "$0" journey ;;
  journey)
    # The journey suite needs two things the dev stack does not start by itself: the document-extractor stand-in (nothing else consumes
    # `onboarding-documents`, so no shop is ever verified and every test times out after 60 s) and the API's metrics port (:9464).
    # Checking them takes seconds; finding out from a 25-minute run does not.
    # the journeys sign in as the seeded admin; a stack that was never seeded answers 401 to all 27 tests (2026-10-16, 11:20 UTC)
    admin_ok() { [[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")" == 200 ]]; }
    if ! admin_ok; then
      (cd "$ROOT/packages/backend" && pnpm --filter api seed:dev >/tmp/sdd-seed.log 2>&1) || true
      admin_ok || { echo "ENVIRONMENT: the seeded admin ($ADMIN_EMAIL) cannot log in even after pnpm --filter api seed:dev (see /tmp/sdd-seed.log)"; tail -n 5 /tmp/sdd-seed.log; exit 1; }
    fi
    LAMBDA_DIR="${LAMBDA_DIR:-/tmp/sdd-lambda}"; mkdir -p "$LAMBDA_DIR"
    [[ -s "$LAMBDA_DIR/pid" ]] && kill -TERM -- "-$(cat "$LAMBDA_DIR/pid")" 2>/dev/null; pkill -f 'lambda-local/main.js' 2>/dev/null; sleep 1
    if ! (cd "$ROOT/packages/backend" && pnpm exec nest build lambda-local >"$LAMBDA_DIR/build.log" 2>&1); then
      echo "ENVIRONMENT: the document-extractor stand-in does not compile (the cause is in $LAMBDA_DIR/build.log):"; grep -m5 "error" "$LAMBDA_DIR/build.log"; exit 1
    fi
    # lambda-local reads dist/lambda-bundles/manifest.json (SD-03), which only `build:lambdas` writes
    if ! (cd "$ROOT/packages/backend" && pnpm run build:lambdas >"$LAMBDA_DIR/bundles.log" 2>&1); then
      echo "ENVIRONMENT: the Lambda bundles do not build (the cause is in $LAMBDA_DIR/bundles.log):"; tail -n 8 "$LAMBDA_DIR/bundles.log"; exit 1
    fi
    # the handlers read their settings (MEDIA_BUCKET, ...) from the process environment when they load, so hand them the dev .env
    # LOG_FILE turns the pretty-print transport off: its worker thread cannot be found from inside a bundle
    (cd "$ROOT/packages/backend" && set -a && . ./.env && set +a && export LOG_FILE="$LAMBDA_DIR/handlers.log" && setsid node dist/apps/lambda-local/main.js document-extractor media-processing >"$LAMBDA_DIR/lambda.log" 2>&1 </dev/null & echo $! > "$LAMBDA_DIR/pid") >/dev/null 2>&1
    sleep 8
    if ! pgrep -f 'lambda-local/main.js' >/dev/null; then
      echo "CODE: the document-extractor stand-in exits at start-up (a module that does not boot outside the monolith, lesson L-018):"; tail -n 12 "$LAMBDA_DIR/lambda.log"; exit 1
    fi
    if grep -qE "Nest can't resolve|UnknownDependencies|Cannot find module" "$LAMBDA_DIR/lambda.log"; then
      echo "CODE: the document-extractor stand-in cannot wire its modules:"; grep -m3 -E "Nest can't resolve|UnknownDependencies|Cannot find module" "$LAMBDA_DIR/lambda.log"; exit 1
    fi
    # after a watch-mode restart the new process may wait for the old one to release :9464; give it a minute
    for _ in $(seq 1 20); do curl -sf -m 5 http://localhost:9464/metrics >/dev/null && break; sleep 3; done
    if ! curl -sf -m 8 http://localhost:9464/metrics >/dev/null; then
      echo "ENVIRONMENT: the API does not serve metrics on :9464. Restart it yourself: bash scripts/sdd/stack-fix.sh api-restart"; exit 1
    fi
    echo "journey environment ok: extractor running, metrics answer on :9464"; exit 0 ;;
  browser)
    cd "$ROOT/packages/web" && pnpm exec playwright install chromium ;;
  reindex)
    tok="$(curl -s -m 15 -X POST "$API_URL/api/auth/login" -H 'content-type: application/json' \
      -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken']['token'])" 2>/dev/null)"
    [[ -n "$tok" ]] || { echo "could not log in as $ADMIN_EMAIL (not seeded yet? run: pnpm --filter api seed:dev)"; exit 1; }
    out="$(curl -s -m 60 -X POST "$API_URL/api/admin/search/reindex" -H "authorization: Bearer $tok" -H 'content-type: application/json' -d '{}')"
    echo "reindex: $out"
    for _ in $(seq 1 30); do
      n="$(curl -s -m 10 "$API_URL/api/products/search?limit=1" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('items',[])))" 2>/dev/null || echo 0)"
      [[ "$n" -gt 0 ]] && { echo "search returns documents again"; exit 0; }
      sleep 4
    done
    echo "the reindex did not produce documents within 2 minutes (is there any product in the database?)"; exit 1 ;;
  *) echo "usage: $0 <smoke|browser|reindex>" >&2; exit 2 ;;
esac
