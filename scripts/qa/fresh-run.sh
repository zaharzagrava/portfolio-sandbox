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
export QA_DIR="${LOG_DIR:-$(mktemp -d)}"
echo "== throwaway stack; logs in $QA_DIR"
"$(dirname "$0")/stack-up.sh" >"$QA_DIR/up.out" 2>&1 || { cat "$QA_DIR/up.out" >&2; exit 1; }

(cd packages/web && PW_EXPECT_TIMEOUT_MS="${PW_EXPECT_TIMEOUT_MS:-20000}" API_URL=http://localhost:8000 pnpm exec playwright test --workers=2 --reporter=list "$@") 2>&1 | tee "$QA_DIR/playwright.log" | tail -n 25
rc=${PIPESTATUS[0]}
scripts/infra/doctor-live.sh || rc=${rc:-1}

"$(dirname "$0")/stack-down.sh" "$QA_DIR"
echo "== playwright exit $rc; logs: $QA_DIR"
exit "$rc"
