#!/usr/bin/env bash
# Find, verify, write the test: the chain that turns what the QA agent finds into failing regression tests, with no person in the middle.
#   scripts/qa/pipeline.sh <charter>... [--minutes N] [--max-fixes N]        exit 1 = at least one failing regression test was written (the checkpoint fails and the repair agent
#                                                                             gets the tests); exit 0 = nothing confirmed and reproduced
#   1 find     scripts/qa/run.sh         the exploratory agent reports CONFIRMED / SUSPICIOUS defects (suspicious ones are never acted on)
#   2 verify   scripts/qa/verify.sh      a second, skeptical session reproduces each CONFIRMED defect and checks it against the living spec: reproduced | gap | not-a-defect | not-reproduced
#   0 dedupe   scripts/qa/dedupe.sh      a finding that is the same defect as a settled earlier one (gap, false, noise, or real with its test) is marked dup and goes no further
#   3 test     scripts/qa/regress.sh     for each reproduced defect, a third session writes packages/web/tests/qa/<charter>-<stamp>-<id>.spec.ts; the test is RUN, and kept only if it FAILS now
# The verdicts are written to the ledger (scripts/qa/findings.tsv) with the same words a person would use; read it and overrule any verdict with scripts/qa/tally.py set.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
ARGS=(); MAXFIX="${MAX_QA_FIXES:-3}"; RUNARGS=()
while [[ $# -gt 0 ]]; do case "$1" in --max-fixes) MAXFIX="$2"; shift 2 ;; --minutes) RUNARGS+=(--minutes "$2"); shift 2 ;; *) ARGS+=("$1"); shift ;; esac; done
[[ ${#ARGS[@]} -gt 0 ]] || ARGS=(buy)
OUT="$ROOT/specs/.qa"; wrote=0; handled=0
for c in "${ARGS[@]}"; do
  before="$(ls "$OUT"/*-"$c".md 2>/dev/null | sort | tail -1)"
  scripts/qa/run.sh "$c" "${RUNARGS[@]}" >/dev/null 2>&1
  report="$(ls "$OUT"/*-"$c".md 2>/dev/null | sort | tail -1)"
  [[ -n "$report" && "$report" != "$before" ]] || { echo "[$c] the agent wrote no new report"; continue; }
  stamp="$(basename "$report" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}).*/\1/')"
  echo "[$c] report $(basename "$report"): $(grep -c '^DEFECT .* CONFIRMED' "$report") confirmed, $(grep -c '^DEFECT .* SUSPICIOUS' "$report") suspicious"
  for id in $(grep '^DEFECT .* CONFIRMED' "$report" | awk '{print $2}'); do
    d="$(scripts/qa/dedupe.sh "$report" "$id")"   # the same defect as a settled earlier one: no verify, no test, no repair, and it does not use up MAX_QA_FIXES
    if [[ "$d" == dup* ]]; then scripts/qa/tally.py set "$stamp" "$c" "$id" dup >/dev/null; echo "[$c] $id: already known (${d#dup }): skipped"; continue; fi
    (( handled >= MAXFIX )) && { echo "[$c] $id left alone: MAX_QA_FIXES=$MAXFIX reached (it stays pending in the ledger)"; continue; }
    handled=$((handled+1))
    v="$(scripts/qa/verify.sh "$report" "$id")"
    case "$v" in
      reproduced)     scripts/qa/tally.py set "$stamp" "$c" "$id" real >/dev/null ;;
      gap)            scripts/qa/tally.py set "$stamp" "$c" "$id" gap >/dev/null ;;
      not-a-defect)   scripts/qa/tally.py set "$stamp" "$c" "$id" noise >/dev/null ;;
      not-reproduced) scripts/qa/tally.py set "$stamp" "$c" "$id" false >/dev/null ;;
    esac
    echo "[$c] $id: verdict $v"
    [[ "$v" == reproduced ]] || continue
    scripts/qa/regress.sh "$report" "$id" >/dev/null 2>&1
    spec="packages/web/tests/qa/$c-$stamp-$id.spec.ts"
    [[ -s "$spec" ]] || { echo "[$c] $id: no test was written"; continue; }
    if (cd packages/web && pnpm exec playwright test "tests/qa/$c-$stamp-$id.spec.ts" --workers=1 --reporter=line >/dev/null 2>&1); then
      echo "[$c] $id: the test PASSES on the current build, so it does not reproduce the defect: discarded"; rm -f "$spec"
      scripts/qa/tally.py set "$stamp" "$c" "$id" false >/dev/null
    else
      echo "[$c] $id: failing regression test written: $spec"; wrote=$((wrote+1))
    fi
  done
done
echo "pipeline: $wrote failing regression test(s) written"
(( wrote == 0 ))
