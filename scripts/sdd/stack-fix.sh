#!/usr/bin/env bash
# Checks and remedies for the local DEV stack that web and journey gates run against. One command the repair agent may run
# (a compound shell line with a login inside would not match its allow-list).
#
#   scripts/sdd/stack-fix.sh smoke     API ready, product search answers 200, Playwright's Chromium installed; says what to run if not
#   scripts/sdd/stack-fix.sh browser   install Playwright's Chromium for the version packages/web uses
#   scripts/sdd/stack-fix.sh reindex   rebuild the product search index from the database (as the seeded admin) and wait for documents
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
