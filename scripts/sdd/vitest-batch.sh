#!/usr/bin/env bash
# vitest-batch.sh <spec files...>: ONE Vitest process for the backend e2e suites, with a Jest-style result at the end of its output.
#   Run from anywhere; files are paths relative to packages/backend (Vitest treats each as a "contains" filter, so give the full relative path).
#   Prints Vitest's own output, then the lines the loop's readers expect: PASS/FAIL per file, "● suite › test" blocks, "Test Suites:" and "Tests:".
#   Env: VITEST_JSON=<file> keeps the machine-readable report there (default: a temp file that is removed); EXTRA_VITEST_ARGS adds flags
#        (for example "--bail=1" or "-t AS-30"); VITEST_ISOLATE=1 gives every file a fresh module cache (slower, rules out cross-file state).
#   Exit code: Vitest's (0 only when every test passed).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
json="${VITEST_JSON:-}"; own=0; [[ -n "$json" ]] || { json="$(mktemp "${TMPDIR:-/tmp}/vitest-batch.XXXXXX.json")"; own=1; }
rm -f "$json"
cd "$ROOT/packages/backend" || exit 2
# shellcheck disable=SC2086
NODE_ENV=test UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}" npx vitest run --config vitest.e2e.config.ts --reporter=default --reporter=json --outputFile.json="$json" --no-color ${EXTRA_VITEST_ARGS:-} "$@"
rc=$?
python3 "$ROOT/scripts/sdd/vitest-summary.py" "$json" "$PWD"
(( own )) && rm -f "$json"
exit $rc
