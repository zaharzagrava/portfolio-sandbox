#!/usr/bin/env bash
# Mutation-test the source files a capability's feature commit(s) touched, or any files changed since a ref. Prints a survivor list per file; exit 1 if a file scores below MIN_SCORE.
#   scripts/mutation/changed.sh [REF] [--max N]        files changed since REF (default origin/master) that have a unit spec next to them
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
REF="origin/master"; MAX=10; [[ "${1:-}" != "" && "${1:-}" != --* ]] && { REF="$1"; shift; }; [[ "${1:-}" == --max ]] && MAX="$2"
rc=0
for f in $(git diff --name-only --diff-filter=AM "$REF" -- 'packages/backend/libs/*.ts' 'packages/backend/apps/*.ts' | grep -vE '\.(spec|e2e-spec|d)\.ts$|/testing/|\.dto\.ts$|\.module\.ts$|index\.ts$|\.model\.ts$'); do
  [[ -f "${f%.ts}.spec.ts" ]] || continue
  python3 scripts/mutation/mutate.py "$f" --max "$MAX" --min-score "${MIN_SCORE:-0.6}" || rc=1
done
exit $rc
