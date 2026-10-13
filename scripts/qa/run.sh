#!/usr/bin/env bash
# The QA agent: a fresh Claude session that uses the running product like a person and reports defects with evidence. It never edits the repository.
#   scripts/qa/run.sh <charter>... [--minutes N] [--out DIR]        charters: scripts/qa/charters/*.md (default: buy)
# The stack and the web server must be up (scripts/qa/stack-up.sh with WITH_WEB=1, or your dev stack + API + web). Exit 1 if a report holds a CONFIRMED defect.
# Reports: specs/.qa/<date>-<charter>.md (with the Playwright scripts it used next to it). Design: docs/notes/2026-10-13-next-steps.md, "the QA agent".
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
source scripts/sdd/lib.sh
CHARTERS=(); MINUTES=""; OUT="$ROOT/specs/.qa"
while [[ $# -gt 0 ]]; do case "$1" in --minutes) MINUTES="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;; *) CHARTERS+=("$1"); shift ;; esac; done
[[ ${#CHARTERS[@]} -gt 0 ]] || CHARTERS=(buy)
curl -sf localhost:3000 >/dev/null && curl -sf localhost:8000/health/ready >/dev/null || { echo "the web server (3000) or the API (8000) does not answer: start the stack first (WITH_WEB=1 scripts/qa/stack-up.sh)" >&2; exit 2; }
mkdir -p "$OUT"; rc=0
for c in "${CHARTERS[@]}"; do
  f="scripts/qa/charters/$c.md"; [[ -f "$f" ]] || { echo "no charter $c" >&2; exit 2; }
  mins="${MINUTES:-$(sed -n 's/^minutes: *//p' "$f" | head -1)}"; mins="${mins:-15}"
  stamp="$(date +%Y-%m-%d-%H%M)"; report="$OUT/$stamp-$c.md"; scripts_dir="$OUT/$stamp-$c.scripts"; mkdir -p "$scripts_dir"
  work="$(mktemp -d)"; mkdir -p "$work/spec"; cp -r docs/spec/concepts "$work/spec/"   # copies: the agent can write only in its scratch directory and the report folder
  pages=""; for id in $(sed -n 's/^specs: *//p' "$f" | head -1); do p="$(ls docs/spec/capabilities/${id}-*.md 2>/dev/null | head -1)"; [[ -n "$p" ]] && { cp "$p" "$work/spec/"; pages+=" $work/spec/$(basename "$p")"; }; done
  apilog="${API_LOG:-$(ls -t /tmp/tmp.*/api.log 2>/dev/null | head -1)}"
  prompt="$(sed "s#<REPO>#$ROOT#g" scripts/qa/prompt.md)

# Your charter ($c), time: $mins minutes
$(sed '1,/^minutes:/d' "$f")

Living-specification pages for this charter (read them first):$pages

REPORT_PATH=$report
SCRIPTS_DIR=$scripts_dir
API_LOG=${apilog:-unknown (use the dev terminal output, or skip log checks)}
Scratch directory (screenshots, notes): $work

$(lessons_block)"
  echo "== QA charter $c ($mins min) -> $report"
  # only these tools: reads, writes in the scratch directory and the report folder, and read-only-by-instruction commands against the throwaway stack
  SPEC_TOOLS=(Read Glob Grep Write 'Bash(curl:*)' 'Bash(jq:*)' 'Bash(node:*)' 'Bash(docker exec:*)' 'Bash(docker logs:*)' 'Bash(tail:*)' 'Bash(grep:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(sleep:*)' "Bash($ROOT/scripts/infra/doctor-live.sh:*)" "Bash($ROOT/scripts/sdd/checkpoints/buy-ui.sh:*)")
  ( cd "$work" && NOTES_DIR="$OUT" PASS_TIMEOUT_S=$(( mins * 60 + 300 )) run_claude "$work/claude.log" "$prompt" )
  [[ -s "$report" ]] || { echo "the agent wrote no report (log: $work/claude.log)" >&2; rc=1; continue; }
  n_conf="$(grep -c '^DEFECT .* CONFIRMED' "$report")"; n_susp="$(grep -c '^DEFECT .* SUSPICIOUS' "$report")"
  # the ledger of everything the agent ever reported (scripts/qa/findings.tsv): verdicts are filled in by a person later (scripts/qa/tally.py --help)
  [[ "$OUT" == "$ROOT/specs/.qa" ]] && grep '^DEFECT ' "$report" | while IFS= read -r l; do   # benchmark runs (--out elsewhere) are not findings on the real build
    id="$(awk '{print $2}' <<<"$l")"; kind="$(awk '{print $3}' <<<"$l")"; sev="$(awk '{print $4}' <<<"$l" | tr -d :)"; title="${l#*: }"
    printf '%s\t%s\t%s\t%s\t%s\tpending\t%s\n' "$stamp" "$c" "$id" "$kind" "$sev" "$title" >> scripts/qa/findings.tsv
  done
  echo "   $n_conf confirmed, $n_susp suspicious: $report"
  (( n_conf > 0 )) && rc=1
done
exit $rc
