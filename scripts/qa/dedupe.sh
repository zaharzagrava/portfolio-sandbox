#!/usr/bin/env bash
# Is this finding the same defect as one that is already settled? The explorer words the same bug differently every time, so word matching does not work; a short
# session with no browser and no stack decides, from the finding and the list of settled ones (scripts/qa/tally.py known).
#   scripts/qa/dedupe.sh <report.md> <D-id>      prints  "dup <stamp> <charter> <id>"  or  "new"
# Settled = gap, false, noise, or real with its regression test in packages/web/tests/qa. A finding that matches only a pending one is NEW: it still has to be handled.
# Unsure means new. With nothing settled yet, no session is started.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
source scripts/sdd/lib.sh
REPORT="$(readlink -f "${1:?usage: dedupe.sh <report.md> <D-id>}")"; ID="${2:?usage: dedupe.sh <report.md> <D-id>}"
charter="$(sed -n 's/^# QA report: *//p' "$REPORT" | head -1)"; stamp="$(basename "$REPORT" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}).*/\1/')"
known="$(scripts/qa/tally.py known | awk -F'\t' -v s="$stamp" -v c="$charter" -v i="$ID" '!($1==s && $2==c && $3==i)')"
[[ -n "$known" ]] || { echo new; exit 0; }
work="$(mktemp -d)"; printf '%s\n' "$known" > "$work/settled.tsv"
awk -v id="$ID" '/^DEFECT /{p=($2==id)} /^## Clean/{p=0} p' "$REPORT" > "$work/finding.md"
[[ -s "$work/finding.md" ]] || { echo new; exit 0; }
prompt="You compare one new bug report with a list of already settled ones, to avoid doing the same work twice.
Read $work/finding.md (the new finding) and $work/settled.tsv (columns: report stamp, charter, id, verdict, title).
Two findings are the SAME defect when one fix would remove both: the same broken endpoint or page with the same cause, even if the wording, the page it was noticed on, or the symptom described differs. They are different when they only look alike (two different endpoints that both answer 400, two different pages that both 404).
Write $work/answer.txt with exactly one line: 'SAME <stamp> <charter> <id>' (the row it matches) or 'NEW'. When unsure, write NEW."
( cd "$work" && NOTES_DIR="$work" SPEC_TOOLS=(Read Write) PASS_TIMEOUT_S=300 run_claude "$work/claude.log" "$prompt" ) >/dev/null 2>&1
a="$(head -1 "$work/answer.txt" 2>/dev/null)"
if [[ "$a" =~ ^SAME\ ([0-9-]+)\ ([a-z0-9-]+)\ (D[0-9]+) ]]; then echo "dup ${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"; else echo new; fi
