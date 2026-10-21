#!/usr/bin/env bash
# Run backend e2e specs and print a condensed result, to save tokens when an agent (or you) iterates.
#   scripts/sdd/test-spec.sh libs/domains/orders/checkout            # path/pattern, as a Vitest file filter (a part of the path)
#   scripts/sdd/test-spec.sh libs/infrastructure/jobs -t "exactly once"
# Prints: the summary lines, and for each failing test its title plus the assertion message and code frame,
# without node_modules stack frames. The full, unfiltered output is saved and its path is printed;
# read that file only when the condensed view is not enough. Exit code is Vitest's. The runner is Vitest (scripts/sdd/vitest-batch.sh); the summary and failure blocks come from its JSON report.
# Env: MAX_FAIL_LINES (default 40) per failing test; TEST_LOGS=1 to keep application logs in the output.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT/packages/backend"
log="$(mktemp "${TMPDIR:-/tmp}/test-spec.XXXXXX.log")"
EXTRA_VITEST_ARGS="--bail=1" timeout "${TEST_SPEC_TIMEOUT_S:-1800}" bash "$ROOT/scripts/sdd/vitest-batch.sh" "$@" >"$log" 2>&1
code=$?
awk -v max="${MAX_FAIL_LINES:-40}" '
  /^Test Suites:|^Tests:|^Snapshots:|^Time:|^Ran all test suites/ { summary = summary $0 "\n"; next }
  /^(PASS|FAIL) [^ ]/ { print; next }
  /^  ● / { infail = 1; n = 0 }
  /^(Test Suites:)/ { infail = 0 }
  infail {
    if ($0 ~ /^[[:space:]]+at .*(node_modules|node:internal)/) next
    if (++n <= max) print
    else if (n == max + 1) print "    … (truncated; see full log)"
  }
  END { printf "%s", summary }
' "$log"
echo "full log: $log (exit $code)"
exit $code
