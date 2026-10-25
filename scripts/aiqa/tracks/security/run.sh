#!/usr/bin/env bash
# Track 11, security scanners on the four seller areas (entry/shop setup, inventory, media, orders).
#   scripts/aiqa/tracks/security/run.sh [static|api|zap|all]     (default all)
#     static  (a) Semgrep, (b) gitleaks, (c) pnpm audit --prod         needs no running app, only Docker + network
#     api     (d) Schemathesis on the API description                  needs the dev stack (API on :8000)
#     zap     (e) OWASP ZAP baseline on the production-build web      needs the dev stack; builds/starts the production server on :3100
# Results: scripts/aiqa/findings/security-{semgrep,gitleaks,audit,schemathesis,zap}.md (plain language; hand verdicts come from triage/<tool>.md).
# Docker is used only to run the scanner containers (docker run --rm); no compose stack is started or stopped.
# What it starts itself (and stops again): the public-api app on :8005 (the only place the /v1 description is served), the
# production web server on :3100. A throwaway test API key (sk_test_) is made for the demo seller and revoked at the end.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HERE="$ROOT/scripts/aiqa/tracks/security"
PROD="$ROOT/scripts/aiqa/tracks/prod-build/prod-server.sh"
cd "$ROOT"
MODE="${1:-all}"
RAW="$(mktemp -d)"; chmod 777 "$RAW"
trap 'rm -rf "$RAW"' EXIT
UIDGID="$(id -u):$(id -g)"
API="${API_URL:-http://localhost:8000}"
SELLER_EMAIL="${SELLER_EMAIL:-seller@marketplace.local}"; SELLER_PW="${SELLER_PW:-Demo-Seed-Pw-7491!}"
sum() { node "$HERE/summarize.mjs" "$1" "$RAW"; }

# The code of the four areas
WEB_DIRS=(packages/web/app/dashboard/seller packages/web/components/seller packages/web/lib/seller packages/web/lib/api)
BACK_DIRS=(packages/backend/libs/domains/catalog packages/backend/libs/domains/media packages/backend/libs/domains/orders packages/backend/libs/domains/tenancy)

static() {
  echo "== (a) Semgrep"
  # self-test of our own rules first: the bad sample must trigger the shop-guard and body rules, or the rules are broken
  docker run --rm --user "$UIDGID" -e HOME=/tmp -v "$HERE/selftest:/src:ro" -v "$HERE/semgrep-rules.yml:/rules.yml:ro" semgrep/semgrep \
    semgrep scan --metrics=off --quiet --config /rules.yml --no-git-ignore --json /src 2>/dev/null > "$RAW/selftest.json"
  for r in aiqa-shop-route-without-shop-guard aiqa-shop-route-method-path-without-shop-guard aiqa-shop-id-read-from-body; do
    grep -q "$r" "$RAW/selftest.json" || echo "WARNING: our rule $r did not fire on its self-test sample; the rule is broken"
  done
  docker run --rm --user "$UIDGID" -e HOME=/tmp -v "$ROOT:/src:ro" -v "$RAW:/out" semgrep/semgrep semgrep scan --metrics=off --quiet \
    --config p/typescript --config p/react --config p/nodejs --config p/owasp-top-ten --config p/secrets --config /src/scripts/aiqa/tracks/security/semgrep-rules.yml \
    --exclude node_modules --exclude '*.test.ts' --exclude '*.test.tsx' --exclude '*.spec.ts' --exclude '*.e2e-spec.ts' --exclude testing \
    --json -o /out/semgrep.json "${WEB_DIRS[@]}" "${BACK_DIRS[@]}" >/dev/null 2>"$RAW/semgrep.err"
  [[ -s "$RAW/semgrep.json" ]] && sum semgrep || { echo "semgrep failed:"; tail -5 "$RAW/semgrep.err"; }

  echo "== (b) gitleaks (history + working copy without ignored files)"
  docker run --rm --user "$UIDGID" -v "$ROOT:/repo:ro" -v "$RAW:/out" zricethezav/gitleaks:latest git /repo -r /out/gl-history.json -f json --no-banner --exit-code 0 >/dev/null 2>&1
  WC="$(mktemp -d)"; git ls-files -co --exclude-standard -z | tar --null -T - -cf - 2>/dev/null | tar -xf - -C "$WC" 2>/dev/null
  docker run --rm --user "$UIDGID" -v "$WC:/repo:ro" -v "$RAW:/out" zricethezav/gitleaks:latest dir /repo -r /out/gl-wc.json -f json --no-banner --exit-code 0 >/dev/null 2>&1
  rm -rf "$WC"
  node -e 'const fs=require("fs"),r=process.argv[1];const rd=f=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")||"[]"):[];fs.writeFileSync(r+"/gitleaks.json",JSON.stringify([...rd(r+"/gl-history.json"),...rd(r+"/gl-wc.json").map(x=>({...x,Commit:""}))]))' "$RAW"
  sum gitleaks

  echo "== (c) pnpm audit --prod"
  for p in web backend; do (cd "packages/$p" && pnpm audit --prod --json > "$RAW/audit-$p.json" 2>/dev/null); done
  sum audit
}

api_up_check() { curl -sf "$API/health/ready" >/dev/null || { echo "the API on $API is not ready: start the dev stack first (scripts/qa/stack-up.sh)"; return 1; }; }

api() {
  echo "== (d) Schemathesis"
  api_up_check || return 1
  local started_pub=""
  if ! curl -sf localhost:8005/v1/openapi.json >/dev/null; then
    # the /v1 description (products, stock, orders for sellers' integrations) is only served by the public-api app, which the dev stack does not start
    mkdir -p /tmp/aiqa-public-api
    (cd packages/backend && NODE_ENV=local PORT=8005 setsid pnpm exec nest start public-api >/tmp/aiqa-public-api/log 2>&1 & echo $! > /tmp/aiqa-public-api/pid)
    started_pub=1
    for _ in $(seq 1 90); do curl -sf localhost:8005/v1/openapi.json >/dev/null && break; sleep 2; done
    curl -sf localhost:8005/v1/openapi.json >/dev/null || { echo "public-api did not start: see /tmp/aiqa-public-api/log"; return 1; }
  fi
  local tok shop kid key
  tok="$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$SELLER_EMAIL\",\"password\":\"$SELLER_PW\"}" | jq -r '.accessToken.token')"
  shop="$(curl -s "$API/api/shops/mine" -H "authorization: Bearer $tok" | jq -r '.items[0].id')"
  local made; made="$(curl -s -X POST "$API/api/shops/$shop/developers/keys" -H "authorization: Bearer $tok" -H 'content-type: application/json' \
    -d '{"name":"aiqa-security-scan","scopes":["products:read","products:write","orders:read","stock:write"],"livemode":false}')"
  key="$(echo "$made" | jq -r .key)"; kid="$(echo "$made" | jq -r .id)"
  [[ "$key" == sk_test_* ]] || { echo "could not make a test API key: $made" | head -c 300; return 1; }
  # paths of the four areas that the description holds: products, stock and orders (the shop-setup/tenancy routes are not in any description)
  docker run --rm --network host --user "$UIDGID" -e HOME=/tmp -v "$RAW:/out" schemathesis/schemathesis:latest run http://localhost:8005/v1/openapi.json \
    --url http://localhost:8005 -H "Authorization: Bearer $key" --include-path-regex '^/v1/(products|stock|orders|batch)' \
    --phases examples,coverage,fuzzing,stateful --max-examples "${ST_EXAMPLES:-25}" --workers 2 --max-time "${ST_SECONDS:-240}" --checks all >"$RAW/schemathesis.txt" 2>&1
  curl -s -X DELETE "$API/api/shops/$shop/developers/keys/$kid" -H "authorization: Bearer $tok" -o /dev/null   # revoke the throwaway key
  [[ -n "$started_pub" && -f /tmp/aiqa-public-api/pid ]] && { kill -- "-$(cat /tmp/aiqa-public-api/pid)" 2>/dev/null; rm -f /tmp/aiqa-public-api/pid; }
  sum schemathesis
}

zap() {
  echo "== (e) OWASP ZAP baseline"
  api_up_check || return 1
  local started=""
  [[ "$("$PROD" status)" == up ]] || { "$PROD" up || return 1; started=1; }
  docker run --rm --network host -v "$RAW:/zap/wrk:rw" -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t http://localhost:3100 -J zap.json -r zap.html -m 2 -I >"$RAW/zap.txt" 2>&1
  [[ -n "$started" ]] && "$PROD" down
  [[ -s "$RAW/zap.json" ]] && sum zap || { echo "zap produced no report:"; tail -5 "$RAW/zap.txt"; }
}

case "$MODE" in
  static) static ;;
  api) api ;;
  zap) zap ;;
  all) static; api; zap ;;
  *) echo "usage: run.sh [static|api|zap|all]"; exit 2 ;;
esac
echo "done: see scripts/aiqa/findings/security-*.md (the summary of real findings: security.md)"
