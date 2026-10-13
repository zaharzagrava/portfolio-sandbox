#!/usr/bin/env bash
# The skeptic: a second fresh Claude session that tries to REPRODUCE one QA finding from its steps alone (it never saw the first session) and checks the claim against the
# living specification. It decides what the finding is, so no person has to read every report. It never edits the repository.
#   scripts/qa/verify.sh <report.md> <D-id>        prints the verdict word; writes <report>.verify-<D-id>.md
# Verdicts: reproduced (a real defect), not-reproduced (could not make it happen), gap (the spec's "Known gaps" or an unbuilt story covers it), not-a-defect (works as the
# spec says, or dev-server noise). Only `reproduced` goes on to a regression test. Needs the stack and the web server up.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
source scripts/sdd/lib.sh
REPORT="${1:?usage: verify.sh <report.md> <D-id>}"; ID="${2:?usage: verify.sh <report.md> <D-id>}"
REPORT="$(readlink -f "$REPORT")"; OUTF="${REPORT%.md}.verify-$ID.md"; rm -f "$OUTF"
charter="$(sed -n 's/^# QA report: *//p' "$REPORT" | head -1)"; specs="$(sed -n 's/^specs: *//p' "scripts/qa/charters/$charter.md" 2>/dev/null | head -1)"
work="$(mktemp -d)"; mkdir -p "$work/spec"; cp -r docs/spec/concepts "$work/spec/"
for id in $specs; do p="$(ls docs/spec/capabilities/${id}-*.md 2>/dev/null | head -1)"; [[ -n "$p" ]] && cp "$p" "$work/spec/"; done
# the finding only: the block that starts at its DEFECT line and ends before the next one
awk -v id="$ID" '/^DEFECT /{p=($2==id)} /^## Clean/{p=0} p' "$REPORT" > "$work/finding.md"
[[ -s "$work/finding.md" ]] || { echo "no finding $ID in $REPORT" >&2; exit 2; }
prompt="$(sed "s#<REPO>#$ROOT#g" scripts/qa/prompt.md | sed -n '/^# The system under test/,/^# How you work/p' | sed '$d')

You are the SKEPTIC. Another tester reported ONE defect (below). You have not seen their session. Decide whether it is real, from evidence you collect yourself.
1. Read the finding: $work/finding.md. Read the living-specification pages in $work/spec/ (rules R-nn, behaviors B-nn, and the 'Known gaps' section).
2. Follow ONLY the steps written in the finding, with a fresh account, twice. Look at the same layers (screen, API, database, queue, log).
3. Check the claim against the spec: does a rule or behavior say the opposite of what the finding calls wrong? Is this listed under Known gaps, or is it a story that is not built yet (a P2/P3 page)? Is it only development-server noise (Next.js dev overlay, hot reload, the dev-mode double effect)?
4. Write $OUTF. FIRST LINE exactly one of:  VERDICT: reproduced | VERDICT: not-reproduced | VERDICT: gap | VERDICT: not-a-defect
   Then: what you did (numbered), what you saw, the evidence (API answer, SQL, log line), and for reproduced: the SMALLEST exact steps and the expected result with its rule id.
Rules: 'reproduced' needs the defect to happen in your own run, both times. If you could not make it happen, say not-reproduced, even if the logs of the first tester look convincing. Never edit repository files, the database, or the queue configuration.

$(cat "$work/finding.md")"
SPEC_TOOLS=(Read Glob Grep Write 'Bash(curl:*)' 'Bash(jq:*)' 'Bash(node:*)' 'Bash(docker exec:*)' 'Bash(docker logs:*)' 'Bash(tail:*)' 'Bash(grep:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(sleep:*)' "Bash($ROOT/scripts/infra/doctor-live.sh:*)")
( cd "$work" && NOTES_DIR="$(dirname "$REPORT")" PASS_TIMEOUT_S="${VERIFY_TIMEOUT_S:-1200}" run_claude "$work/claude.log" "$prompt" ) >/dev/null 2>&1
v="$(sed -n '1s/^VERDICT: *//p' "$OUTF" 2>/dev/null | tr -d '[:space:]')"
case "$v" in reproduced|not-reproduced|gap|not-a-defect) echo "$v" ;; *) echo "no-verdict" ;; esac
