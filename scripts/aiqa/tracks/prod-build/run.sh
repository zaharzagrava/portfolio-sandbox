#!/usr/bin/env bash
# Track 5, production build: the monkey tester and the API fuzzer against the production web server, plus the re-check of the
# findings that were only seen on the dev server (B-003 CSP inline-style errors, B-005 hydration mismatch, B-026 not-found HTTP 200,
# B-031 401 console noise).
#   scripts/aiqa/tracks/prod-build/run.sh [--minutes 10] [--seed N] [--skip-monkey] [--skip-fuzz] [--keep-server]
# Needs the dev stack and API on :8000 (scripts/qa/stack-up.sh); the dev web server on :3000 is the control for the re-check.
# Starts the production server on :3100 if it is not up (building it only when .next-prod is older than the sources) and stops it
# at the end only if this script started it. Result: scripts/aiqa/findings/prod-build.md (hand verdicts: prod-build/triage.md).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
HERE="$ROOT/scripts/aiqa/tracks/prod-build"
cd "$ROOT"
MIN=10; SEED=$(( RANDOM * 32768 + RANDOM )); MONKEY=1; FUZZ=1; KEEP=""
while [[ $# -gt 0 ]]; do case "$1" in
  --minutes) MIN="$2"; shift 2 ;; --seed) SEED="$2"; shift 2 ;; --skip-monkey) MONKEY=""; shift ;; --skip-fuzz) FUZZ=""; shift ;; --keep-server) KEEP=1; shift ;;
  *) echo "unknown option $1"; exit 2 ;; esac; done
curl -sf localhost:8000/health/ready >/dev/null || { echo "the API on :8000 is not ready: start the dev stack first"; exit 1; }
RAW="$(mktemp -d)"; trap 'rm -rf "$RAW"' EXIT
STARTED=""
[[ "$("$HERE/prod-server.sh" status)" == up ]] || { "$HERE/prod-server.sh" up || exit 1; STARTED=1; }
[[ -f /tmp/aiqa-prod-server/webdir ]] && COPY=true || COPY=false
echo "== re-check of B-003 B-005 B-026 B-031 (dev control vs production)"
node "$HERE/recheck.mjs" --dev "${DEV_WEB:-http://localhost:3000}" --prod http://localhost:3100 --api http://localhost:8000 --out "$RAW/recheck.json" || echo "recheck failed"
MD=- ; FD=-
if [[ -n "$MONKEY" ]]; then
  echo "== monkey, $MIN minutes, seed $SEED, on the production build"
  node scripts/qa/monkey-seller.mjs --minutes "$MIN" --seed "$SEED" --web http://localhost:3100 --api http://localhost:8000 2>&1 | tee "$RAW/monkey.log" | tail -25
  MD="$ROOT/$(grep -o 'specs/.checkpoints/qa-monkey/[^/ ]*' "$RAW/monkey.log" | tail -1)"
fi
if [[ -n "$FUZZ" ]]; then
  echo "== fuzzer, $MIN minutes, seed $SEED"
  node scripts/qa/fuzz-seller-api.mjs --minutes "$MIN" --seed "$SEED" --api http://localhost:8000 2>&1 | tee "$RAW/fuzz.log" | tail -25
  FD="$ROOT/$(grep -o 'specs/.checkpoints/qa-fuzz/[^/ ]*' "$RAW/fuzz.log" | tail -1)"
fi
echo "{\"minutes\":$MIN,\"monkeySeed\":$SEED,\"fuzzSeed\":$SEED,\"copyBuild\":$COPY}" > "$RAW/meta.json"
KEEP_DIR="$ROOT/specs/.checkpoints/qa-prod-build/$(date +%Y-%m-%dT%H-%M-%S)"; mkdir -p "$KEEP_DIR"; cp "$RAW"/recheck.json "$RAW"/meta.json "$RAW"/monkey.log "$RAW"/fuzz.log "$KEEP_DIR/" 2>/dev/null   # raw evidence stays
[[ -s "$RAW/recheck.json" ]] && node "$HERE/report.mjs" "$RAW/recheck.json" "$MD" "$FD" "$RAW/meta.json"
[[ -n "$STARTED" && -z "$KEEP" ]] && "$HERE/prod-server.sh" down
