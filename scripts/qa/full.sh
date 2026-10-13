#!/usr/bin/env bash
# The full QA pass: every charter, no budget. NOT part of the build loop (it takes hours: about 20 minutes per charter). Run it by hand, or on a machine of its own,
# before a release or about once a week. It writes failing regression tests (the next checkpoint's repair agent fixes them); it does not fix anything itself.
#   scripts/qa/full.sh [--max-fixes N]      needs the stack, the API and the web server up (WITH_WEB=1 scripts/qa/stack-up.sh)
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
MAXFIX="${MAX_QA_FIXES:-20}"; [[ "${1:-}" == "--max-fixes" ]] && MAXFIX="$2"
exec scripts/qa/pipeline.sh $(scripts/qa/select.py --all) --max-fixes "$MAXFIX"
