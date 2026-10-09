#!/usr/bin/env bash
# checkpoint.sh <label>: what must be true before the loop pauses at a "!STOP <label>" checkpoint.
#   1. Regression sweep: every backend e2e spec built so far still passes. The per-capability gate only runs the e2e specs
#      of the capability being built, so a later spec that edits shared code could break an earlier one unseen.
#   2. If the dev stack is up (GET $API_URL/health/ready) and packages/web has Playwright specs: the web suite still passes.
#   3. scripts/sdd/checkpoints/<label>.sh, if it exists: a scripted walk of the flow (exit 0 = the flow works).
# Exit 0 = the checkpoint may be passed. CHECKPOINT_SWEEP=0 skips 1 and 2 (the label script still runs).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
label="${1:?usage: checkpoint.sh <label>}"
API_URL="${API_URL:-http://localhost:8000}"
log="$ROOT/specs/.checkpoints/$label.log"
mkdir -p "$ROOT/specs/.checkpoints"; : > "$log"
fail=0

if [[ "${CHECKPOINT_SWEEP:-1}" != 0 ]]; then
  echo "  checkpoint $label: backend e2e sweep (log: $log)"
  (cd packages/backend && NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules timeout "${SWEEP_TIMEOUT_S:-3600}" \
     npx jest --ci --runInBand --forceExit --config jest-e2e.json --colors=false) >>"$log" 2>&1 || { echo "  backend e2e sweep FAILED"; fail=1; }
  if [[ -d packages/web ]] && ls packages/web/playwright.config.* >/dev/null 2>&1 && curl -sf "$API_URL/health/ready" >/dev/null; then
    echo "  checkpoint $label: web (Playwright) sweep"
    (cd packages/web && timeout "${SWEEP_TIMEOUT_S:-3600}" npx playwright test --reporter=line --max-failures=3) >>"$log" 2>&1 || { echo "  web sweep FAILED"; fail=1; }
  fi
fi

script="$ROOT/scripts/sdd/checkpoints/$label.sh"
if [[ -x "$script" ]]; then
  echo "  checkpoint $label: flow script"
  "$script" >>"$log" 2>&1 || { echo "  flow script FAILED"; fail=1; }
fi

if (( fail )); then echo "checkpoint $label failed; see $log"; tail -n 25 "$log" | cut -c1-200; fi
exit "$fail"
