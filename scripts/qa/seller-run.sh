#!/usr/bin/env bash
# Runs the ten seller-dashboard charters (scripts/qa/charters/seller-*.md) with QA agents, one after another or a few at once, on its own git branch.
# Plan: docs/work/plans/2026-10-24-qa-seller-dashboard.md. Notes in plain words: docs/work/speedup-notes/qa-runner.md
#   scripts/qa/seller-run.sh [--parallel N] [--only a,b] [--no-fix] [--retries N] [--budget MINUTES] [--list]
# Environment: QA_PARALLEL (3), QA_RETRIES (1), QA_BUDGET_MIN (240), QA_BASE (master), QA_BRANCH (qa/seller-dashboard),
#              QA_WORKTREE (../<repo>-qa), QA_STATE (specs/.checkpoints/qa-seller), QA_MAX_FIXES (15).
# For each charter: an explorer agent (scripts/qa/run.sh, only reads and reports), then, unless --no-fix, a fixer agent in the branch's own
# working copy that fixes the confirmed defects with one commit each. Every new commit goes through scripts/qa/guard-tests.sh; a commit that
# weakens a test or is too big is undone with `git revert` on the branch. Nothing is ever sent to a remote, and master is only the starting point.
# The stack must already run (WITH_WEB=1 scripts/qa/stack-up.sh); for fixes to show up in the browser, start it from the branch's working copy.
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${QA_REPO:-$(git -C "$SELF" rev-parse --show-toplevel)}"
source "$SELF/../sdd/lib.sh"

PARALLEL="${QA_PARALLEL:-3}"; RETRIES="${QA_RETRIES:-1}"; BUDGET_MIN="${QA_BUDGET_MIN:-240}"; NO_FIX="${QA_NO_FIX:-}"; ONLY=""; LIST=""
BASE="${QA_BASE:-master}"; BRANCH="${QA_BRANCH:-qa/seller-dashboard}"; MAX_FIXES="${QA_MAX_FIXES:-15}"
WT="${QA_WORKTREE:-$(dirname "$ROOT")/$(basename "$ROOT")-qa}"
STATE="${QA_STATE:-$ROOT/specs/.checkpoints/qa-seller}"
CHARTERS_DIR="${QA_CHARTERS_DIR:-$ROOT/scripts/qa/charters}"
EXPLORE="${QA_EXPLORE_CMD:-$SELF/run.sh}"; GUARD="${QA_GUARD_CMD:-$SELF/guard-tests.sh}"
WEB_URL="${QA_WEB_URL:-localhost:3000}"; API_URL="${QA_API_URL:-localhost:8000/health/ready}"
while [[ $# -gt 0 ]]; do case "$1" in
  --parallel) PARALLEL="$2"; shift 2 ;; --only) ONLY="$2"; shift 2 ;; --no-fix) NO_FIX=1; shift ;;
  --retries) RETRIES="$2"; shift 2 ;; --budget) BUDGET_MIN="$2"; shift 2 ;; --list) LIST=1; shift ;;
  -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) echo "unknown option $1 (see --help)" >&2; exit 2 ;; esac; done
(( PARALLEL >= 1 )) 2>/dev/null || { echo "--parallel must be a number, 1 or more" >&2; exit 2; }
(( PARALLEL > 3 )) && PARALLEL=3   # three at once is all this laptop carries

# The fixed order: steady ones first; orders and overview-live last and alone (they count things other shops would disturb).
PARALLEL_SET=(seller-shop-setup seller-products seller-photos seller-video seller-inventory-stock seller-bulk-import seller-team seller-developers)
ALONE_SET=(seller-orders seller-overview-live)
wanted() { [[ -z "$ONLY" ]] && return 0; local x; for x in ${ONLY//,/ }; do [[ "$x" == "$1" || "seller-$x" == "$1" ]] && return 0; done; return 1; }
FIRST=(); LAST=()
for c in "${PARALLEL_SET[@]}"; do wanted "$c" && FIRST+=("$c"); done
for c in "${ALONE_SET[@]}"; do wanted "$c" && LAST+=("$c"); done
if [[ -n "$ONLY" ]]; then   # a typo in --only must not silently run nothing
  for x in ${ONLY//,/ }; do
    ok=""; for c in "${PARALLEL_SET[@]}" "${ALONE_SET[@]}"; do [[ "$x" == "$c" || "seller-$x" == "$c" ]] && ok=1; done
    [[ -n "$ok" ]] || { echo "no such charter: $x" >&2; exit 2; }
  done
fi
if [[ -n "$LIST" ]]; then
  echo "together (up to $PARALLEL at once): ${FIRST[*]:-none}"; echo "alone, last, in this order: ${LAST[*]:-none}"; exit 0
fi

# 1. the stack must answer
stack_ok() { curl -sf "$WEB_URL" >/dev/null && curl -sf "$API_URL" >/dev/null; }
stack_ok || { echo "the web server ($WEB_URL) or the API ($API_URL) does not answer. Start the stack first:  WITH_WEB=1 scripts/qa/stack-up.sh" >&2; exit 2; }

# 2. the branch and its own working copy
git -C "$ROOT" rev-parse --verify -q "$BASE^{commit}" >/dev/null || { echo "no base branch $BASE in $ROOT" >&2; exit 2; }
if [[ ! -e "$WT/.git" ]]; then
  if git -C "$ROOT" rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null; then git -C "$ROOT" worktree add "$WT" "$BRANCH" >/dev/null 2>&1
  else git -C "$ROOT" worktree add -b "$BRANCH" "$WT" "$BASE" >/dev/null 2>&1; fi || { echo "could not make the working copy $WT for $BRANCH" >&2; exit 2; }
fi
[[ "$(git -C "$WT" branch --show-current)" == "$BRANCH" ]] || { echo "$WT is not on $BRANCH: refusing to touch it" >&2; exit 2; }
[[ -z "$(git -C "$WT" status --porcelain)" ]] || { echo "$WT has uncommitted changes: commit or remove them first" >&2; exit 2; }

mkdir -p "$STATE/reports"
RESULTS="$STATE/results.tsv"; CHANGES="$STATE/changes.md"
[[ -s "$RESULTS" ]] || printf 'charter\tstart\tend\tstatus\tfindings\tcommits\n' > "$RESULTS"
[[ -s "$CHANGES" ]] || printf '# Changes made by the QA fixers on %s\n\nOne entry per commit: what, why, which test. Rejected ones are marked REVERTED.\n' "$BRANCH" > "$CHANGES"
T0=$(date +%s); export RUN_DEADLINE=$(( T0 + BUDGET_MIN * 60 ))   # run_claude (lib.sh) stops any agent that would outlive this
STOP="$STATE/.stop"; rm -f "$STOP"
now() { date '+%Y-%m-%d %H:%M:%S'; }
say() { echo "[$(now)] $*"; }

charter_minutes() { local m; m="$(sed -n 's/^minutes: *//p' "$CHARTERS_DIR/$1.md" | head -1)"; echo "${m:-15}"; }
row() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$RESULTS"; }   # one short line: safe to append from parallel jobs

# the fixer agent: works in the branch's working copy, one commit per confirmed defect
default_fixer() {
  local c="$1" report="$2" log="$3"
  local prompt="You fix the defects a QA agent found in the seller dashboard. Work ONLY in $WT (branch $BRANCH). Read the report $report; handle each DEFECT marked CONFIRMED, at most 5.
For each: (1) write the failing test first (a Playwright test in packages/web/tests, or a backend end-to-end test, whichever sees the bug lowest) and run it to see it fail; (2) fix the product; (3) run it to see it pass, then the neighbouring tests; (4) make ONE commit holding test and fix, with a message that has a first line, then the lines 'Why: <one plain sentence>', 'Defect: $c <id>', 'Test: <test name>'.
Rules, checked by a script after you: never delete or skip a test, never weaken an expectation, never raise a timeout or add retries, never edit test settings or the spec text; a fix is at most 150 changed lines and 5 files, else write 'needs the owner' in your answer and leave it. If an existing test seems wrong, say so in your answer and leave it. Never use git push, git reset, or switch branch. Never start a command in the background."
  ( cd "$WT" && NOTES_DIR="$STATE" SPEC_TOOLS=(Read Glob Grep Write Edit 'Bash(git add:*)' 'Bash(git commit:*)' 'Bash(git status:*)' 'Bash(git diff:*)' 'Bash(git log:*)' 'Bash(pnpm:*)' 'Bash(npx:*)' 'Bash(curl:*)' 'Bash(ls:*)' 'Bash(cat:*)' 'Bash(grep:*)' 'Bash(sleep:*)' "Bash($ROOT/scripts/infra/doctor-live.sh:*)") \
      PASS_TIMEOUT_S=$(( ( $(charter_minutes "$c") + 10 ) * 60 )) run_claude "$log.fix" "$prompt" ); local rc=$?
  cat "$log.fix" >> "$log" 2>/dev/null; rm -f "$log.fix"; return $rc
}
FIXER="${QA_FIX_CMD:-default_fixer}"   # called: <charter> <report> <logfile>

# After a fixer: check every new commit with the guard, undo bad ones, write the changes log. Prints the number of kept commits.
review_commits() {
  local c="$1" head0="$2" kept=0 sha why test files out; local -a bad=()
  # leftovers the agent did not commit are thrown away (inside the branch's own working copy only)
  git -C "$WT" checkout -- . 2>/dev/null; git -C "$WT" clean -fdq 2>/dev/null
  for sha in $(git -C "$WT" rev-list --reverse "$head0..HEAD"); do
    files="$(git -C "$WT" show --format= --name-only "$sha" | tr '\n' ' ')"
    why="$(git -C "$WT" show -s --format=%B "$sha" | sed -n 's/^Why: *//p' | head -1)"; why="${why:-$(git -C "$WT" show -s --format=%s "$sha")}"
    test="$(git -C "$WT" show -s --format=%B "$sha" | sed -n 's/^Test: *//p' | head -1)"
    if out="$("$GUARD" "$sha" "$WT" 2>&1)"; then
      kept=$((kept + 1))
      printf '\n## %s  %s  %s\n- what: %s\n- why: %s\n- test: %s\n- files: %s\n' "$(now)" "$(git -C "$WT" rev-parse --short "$sha")" "$c" "$(git -C "$WT" show -s --format=%s "$sha")" "$why" "${test:-not named in the commit}" "$files" >> "$CHANGES"
    else
      bad+=("$sha")
      printf '\n## %s  %s  %s  REVERTED by the test guard\n- what: %s\n- guard said: %s\n- files: %s\n' "$(now)" "$(git -C "$WT" rev-parse --short "$sha")" "$c" "$(git -C "$WT" show -s --format=%s "$sha")" "$(tr '\n' ' ' <<<"$out")" "$files" >> "$CHANGES"
    fi
  done
  local i   # undo the newest first, so later changes do not block earlier reverts
  for (( i = ${#bad[@]} - 1; i >= 0; i-- )); do
    git -C "$WT" revert --no-edit "${bad[$i]}" >/dev/null 2>&1 || { git -C "$WT" revert --abort 2>/dev/null; echo "- COULD NOT REVERT ${bad[$i]}: the owner must look at it" >> "$CHANGES"; }
  done
  echo "$kept"
}

# one charter from start to end; its answer is one row in results.tsv
run_charter() {
  local c="$1" log="$STATE/$c.log" mins start_s attempt=0 used status="" rep="" findings=0 commits=0 marker head0
  mins="$(charter_minutes "$c")"; start_s="$(now)"; : > "$log"
  if [[ -e "$STOP" ]]; then row "$c" "$start_s" "$(now)" "skipped (run stopped)" 0 0; return; fi
  local left=$(( (RUN_DEADLINE - $(date +%s)) / 60 ))
  if (( left < 5 )); then row "$c" "$start_s" "$(now)" "not run (budget used)" 0 0; return; fi
  while :; do
    marker="$STATE/.marker-$c"; touch "$marker"; sleep 1
    used=$SECONDS
    say "$c: explorer, $mins min (attempt $((attempt + 1)))" >> "$log"
    timeout --kill-after=30 $(( (mins + 8) * 60 )) "$EXPLORE" "$c" --minutes "$mins" --out "$STATE/reports" >> "$log" 2>&1
    rep="$(find "$STATE/reports" -maxdepth 1 -name "*-$c.md" -newer "$marker" 2>/dev/null | head -1)"
    [[ -n "$rep" && -s "$rep" ]] && { status=explored; break; }
    # no report: the session crashed, ran out of time, or the stack is gone
    stack_ok || { status="stack down"; touch "$STOP"; break; }
    attempt=$((attempt + 1))
    if (( attempt > RETRIES )); then status=crashed; break; fi
    mins=$(( mins - (SECONDS - used) / 60 )); (( mins < 5 )) && mins=5
    say "$c: no report, trying again in 30 s with $mins min" >> "$log"; sleep "${QA_RETRY_WAIT:-30}"
  done
  rm -f "$marker"
  if [[ "$status" == explored ]]; then
    findings="$(grep -c '^DEFECT .* CONFIRMED' "$rep")"; status=done
    if [[ -z "$NO_FIX" && "$findings" -gt 0 ]]; then
      exec 9>"$STATE/.fix.lock"; flock 9   # fixes strictly one at a time: they share one working copy
      if [[ -e "$STOP" ]] || (( $(git -C "$WT" rev-list --count "$BASE..$BRANCH") >= MAX_FIXES )); then status="done (fixes skipped)"
      elif (( RUN_DEADLINE - $(date +%s) < 600 )); then status="done (no time to fix)"
      else
        head0="$(git -C "$WT" rev-parse HEAD)"
        say "$c: fixer for $findings confirmed defect(s)" >> "$log"
        "$FIXER" "$c" "$rep" "$log"; (( $? != 0 )) && status="done (fixer failed)"
        commits="$(review_commits "$c" "$head0")"
      fi
      flock -u 9; exec 9>&-
    fi
  fi
  row "$c" "$start_s" "$(now)" "$status" "$findings" "$commits"
  case "$status" in
    done*) notify ok "QA $c" "$status: $findings confirmed, $commits fix commit(s)" ;;
    *)     notify fail "QA $c" "$status (log: $log)" ;;
  esac
  say "$c: $status ($findings confirmed, $commits commits)"
}

say "branch $BRANCH in $WT; charters: ${FIRST[*]} ${LAST[*]}; at most $PARALLEL at once; budget $BUDGET_MIN min; state in $STATE"
for c in "${FIRST[@]}"; do
  [[ -e "$STOP" ]] && break
  while (( $(jobs -rp | wc -l) >= PARALLEL )); do wait -n; done
  run_charter "$c" &
done
wait
for c in "${LAST[@]}"; do run_charter "$c"; done   # alone, one after the other

if (( $(date +%s) >= RUN_DEADLINE )); then notify limit "QA seller run" "the $BUDGET_MIN minute budget is out"; fi
echo; column -t -s $'\t' "$RESULTS"
echo; echo "commits on $BRANCH:"; git -C "$WT" log --oneline "$BASE..$BRANCH"
notify ok "QA seller run finished" "$(awk -F'\t' 'NR>1' "$RESULTS" | wc -l) charter rows, see $RESULTS"
[[ -e "$STOP" ]] && exit 1
exit 0
