#!/usr/bin/env bash
# Turns one QA finding into a regression test: a fresh Claude session reads the report and the Playwright scripts the agent saved, and writes ONE spec in
# packages/web/tests/qa/<charter>-<id>.spec.ts that reproduces the defect (an API check is fine when the defect is not in the browser). The spec must FAIL while the
# defect exists. Run it with the defect present to confirm, and again after the fix. A person judges the finding first: only verdict `real` is accepted.
#   scripts/qa/regress.sh <report.md> <D-id>        e.g. scripts/qa/regress.sh specs/.qa/2026-10-13-0810-buy.md D1
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
source scripts/sdd/lib.sh
REPORT="${1:?usage: regress.sh <report.md> <D-id>}"; ID="${2:?usage: regress.sh <report.md> <D-id>}"
charter="$(sed -n 's/^# QA report: *//p' "$REPORT" | head -1)"; stamp="$(basename "$REPORT" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}).*/\1/')"
verdict="$(awk -F'\t' -v s="$stamp" -v c="$charter" -v i="$ID" '$1==s && $2==c && $3==i {print $6}' scripts/qa/findings.tsv)"
[[ "$verdict" == real ]] || { echo "finding $ID of $REPORT has verdict '${verdict:-unknown}', not 'real': judge it first (scripts/qa/tally.py set $stamp $charter $ID real)" >&2; exit 2; }
SCRIPTS="${REPORT%.md}.scripts"; OUTSPEC="packages/web/tests/qa/${charter}-${ID}.spec.ts"; mkdir -p packages/web/tests/qa
prompt="You write one regression test. Read the QA report $ROOT/$REPORT (defect $ID only) and the Playwright scripts the QA agent saved in $ROOT/$SCRIPTS.
Write $ROOT/$OUTSPEC as a Playwright test in the style of the other specs in $ROOT/packages/web/tests (imports from ../helpers, uses createIsolatedProduct, register and the other helpers; every test creates its own data).
The test title MUST start with 'QA-$charter-$ID:' and then say what must be true. It must reproduce the steps of the defect and assert the EXPECTED behavior, so that it FAILS while the defect exists and passes once fixed. Never read a response body inside an assertion message (await res.text() throws on an empty 202 and turns a passing test into a failing one): assert on the status or read the body only inside a failure branch.
Keep it small and deterministic (no fixed sleeps: poll with expect.poll or toBeVisible with a timeout). Write nothing else.
$(lessons_block)"
NOTES_DIR="$ROOT/packages/web/tests" SPEC_TOOLS=(Read Glob Grep Write) run_claude "$(mktemp)" "$prompt" || { echo "the agent failed" >&2; exit 1; }
[[ -s "$OUTSPEC" ]] || { echo "no spec was written" >&2; exit 1; }
echo "wrote $OUTSPEC; now run it WITH the defect present (it must fail) and after the fix (it must pass):"
echo "  (cd packages/web && pnpm exec playwright test tests/qa/${charter}-${ID}.spec.ts --workers=1)"
