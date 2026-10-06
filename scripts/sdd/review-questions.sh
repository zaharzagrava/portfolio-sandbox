#!/usr/bin/env bash
# Step 3 helper (docs/architecture/sdd-runbook.md): the defaults the spec agents chose, highest impact first.
# Prints [BREAKING] and [CONTRACT] lines from every questions.md, grouped by capability. [LOCAL] lines are
# counted, not printed. Files written before the tags existed are printed in full and marked untagged.
#
#   scripts/sdd/review-questions.sh            # BREAKING + CONTRACT across all specs
#   scripts/sdd/review-questions.sh BREAKING   # only one tag
#   scripts/sdd/review-questions.sh --all      # also LOCAL lines
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"
case "${1:-}" in
  --all) TAGS='BREAKING|CONTRACT|LOCAL' ;;
  '')    TAGS='BREAKING|CONTRACT' ;;
  *)     TAGS="$1" ;;
esac

declare -A total=()
for f in specs/{domains,web,journeys}/*/questions.md; do
  [[ -f "$f" ]] || continue
  cap="$(basename "$(dirname "$f")")"
  if ! grep -qE '^- \[(BREAKING|CONTRACT|LOCAL)\]' "$f"; then
    printf '\n### %s (untagged: written before impact tags; review all lines)\n' "$cap"
    grep -E '^[0-9]+\.|^- ' "$f" || true
    continue
  fi
  lines="$(grep -E "^- \[($TAGS)\]" "$f" || true)"
  for t in BREAKING CONTRACT LOCAL; do total[$t]=$(( ${total[$t]:-0} + $(grep -cE "^- \[$t\]" "$f" || true) )); done
  [[ -n "$lines" ]] && printf '\n### %s\n%s\n' "$cap" "$lines"
done
printf '\nTotals: BREAKING %s, CONTRACT %s, LOCAL %s (LOCAL hidden unless --all)\n' "${total[BREAKING]:-0}" "${total[CONTRACT]:-0}" "${total[LOCAL]:-0}"
echo "Edit a line in its questions.md to override the default; the implementation agent follows edited lines."
