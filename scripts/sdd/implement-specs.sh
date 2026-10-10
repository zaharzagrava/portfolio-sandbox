#!/usr/bin/env bash
# Sequential implementation (docs/architecture/sdd-runbook.md, step 4). For each written spec, in the order of
# scripts/sdd/orders/$ORDER.txt (by-layer, the default: platform, identity, money chain, ..., web, journeys; or by-flow: vertical slices with checkpoints): plan → tasks → analyze → implement → converge
# (→ implement again if converge added tasks), then a hard gate for that kind of capability. Stops at the
# first failure so a human can step in; re-running resumes, because finished specs carry `.implemented`.
#
#   scripts/sdd/implement-specs.sh              # every spec that has spec.md and no .implemented
#   scripts/sdd/implement-specs.sh S10 orders   # filter by IDs and/or domain columns (also `web`, `journeys`)
#   COMMIT=1 scripts/sdd/implement-specs.sh     # commit after each green spec (recommended)
#   UNTIL=S16 scripts/sdd/implement-specs.sh    # stop after that capability (cap token spend)
#   GATE_ONLY=1 scripts/sdd/implement-specs.sh S54   # just re-run the gate: no claude call, no marker, no commit
#   MAX_IMPLEMENT_PASSES=10 (default): implement runs in fresh-context passes until every task in tasks.md is checked
#
# Prerequisites (runbook step 4):
#   backend (S): the e2e test stores are up: `moon run infra-test-setup` (own terminal)
#   web (W) and journeys (J): also the local dev stack: `moon run infra-setup`,
#     `moon run dev-monolith` (API on $API_URL, watch mode). Playwright starts the web dev server itself.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
cd "$ROOT"

# How the run ended, for the notification. The build loop runs in a pipeline subshell, so its verdict goes through a file.
STATE_FILE="$(mktemp)"
on_exit() {
  local code=$? state; state="$(cat "$STATE_FILE" 2>/dev/null)"; rm -f "$STATE_FILE"
  if [[ "$state" == deadline:* ]]; then
    echo "TIME BUDGET USED  ${state#deadline:}. Everything committed so far is kept; start another run to continue." >&2
    notify warn "SDD loop: time budget used" "${state#deadline:}. Progress is committed; start another run to continue."
  elif [[ "$state" == auth:* ]]; then
    echo "LOGIN FAILED  ${state#auth:}" >&2
    notify fail "SDD loop: Claude login failed" "${state#auth:}. Create a new token with 'claude setup-token' and update the runner config."
  elif [[ "$state" == limit:* ]]; then
    echo "OUT OF BUDGET  the Claude usage limit was reached at ${state#limit:}. Nothing is lost: re-run the same command after the limit resets and it resumes." >&2
    notify limit "SDD loop: out of budget" "Usage limit hit at ${state#limit:}. Re-run after the reset to resume."
  elif (( code == 78 )); then
    echo "FINISHED WITH BLOCKED CAPABILITIES  ${state#blocked:}  (see BLOCKED.md in each spec folder)" >&2
    notify warn "SDD loop: finished, but some capabilities are blocked" "${state#blocked:}. Each has a BLOCKED.md that says why; everything else is built and pushed."
  elif [[ "$state" == Checkpoint* ]] && (( code == 0 )); then
    notify ok "SDD loop: checkpoint reached" "$state"
  elif (( code == 0 )); then
    notify ok "SDD loop: finished" "${state:-All requested specs are built.}"
  else
    notify fail "SDD loop: stopped" "${state:-Exit code $code.} See the terminal."
  fi
}
trap on_exit EXIT
API_URL="${API_URL:-http://localhost:8000}"

# Implementation needs to build and run tests, on top of the file tools in lib.sh.
TEST_SPEC="$ROOT/scripts/sdd/test-spec.sh"   # condensed e2e runner: far fewer tokens per red/green iteration
IMPL_TOOLS=("Bash($TEST_SPEC:*)" 'Bash(npx tsc:*)' 'Bash(npx jest:*)' 'Bash(npx nest build:*)' 'Bash(npx vitest:*)' 'Bash(npx playwright:*)'
            'Bash(python3 scripts/sdd/check-tests.py:*)' 'Bash(python3 scripts/sdd/tasks-scope.py:*)' 'Bash(pnpm:*)' 'Bash(node:*)' 'Bash(docker compose:*)' 'Bash(curl:*)'
            'Bash(cd:*)' 'Bash(cat:*)' 'Bash(grep:*)' 'Bash(find:*)' 'Bash(git log:*)')

# push_branch: with PUSH_BRANCH set, publish HEAD to that branch (best effort; the VPS runner sets it so nothing is lost).
push_branch() {
  [[ -n "${PUSH_BRANCH:-}" ]] || return 0
  git push -q origin "HEAD:refs/heads/$PUSH_BRANCH" 2>&1 | tail -2 || true
}

# Where a backend capability's code and e2e specs live, relative to packages/backend.
code_path() {
  case "$1" in
    infrastructure) echo "libs/infrastructure" ;;
    composition)    echo "libs/composition" ;;
    *)              echo "libs/domains/$1" ;;
  esac
}

# NOTE on `set -e`: these functions run inside `if ! gate …`, where bash ignores errexit, so every step is chained
# explicitly with && / || return 1; otherwise a failing tsc or jest would not stop the gate.

# Every kind runs this: web and journey work may change backend code too.
backend_core_gate() {
  (
    cd packages/backend &&
    rm -f tsconfig.tsbuildinfo &&
    npx tsc --noEmit -p tsconfig.json &&
    NODE_OPTIONS=--experimental-vm-modules npx jest --ci &&   # same flag as `pnpm test`: uuid and marked are ESM
    NODE_ENV=test pnpm check:module-graph &&      # one process per app: barrel cycles that tsc can't see
    NODE_ENV=test pnpm check:model-registry &&    # every app's Sequelize models wire their associations
    pnpm check:boundaries                         # constitution X.4/X.5/X.8 (dependency-cruiser)
  )
}

gate() { # $1 = domain column; everything must pass
  backend_core_gate || return 1
  case "$(kind_of "$1")" in
    backend)
      (cd packages/backend && NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules timeout 1800 npx jest --ci --runInBand --forceExit --config jest-e2e.json "$(code_path "$1")") || return 1 ;;
    web)
      (
        cd packages/web &&
        npx tsc --noEmit -p tsconfig.json &&
        pnpm test &&                               # Vitest: UI-only logic, component states, a11y
        API_URL="$API_URL" pnpm test:e2e           # Playwright: happy-path journeys + layout screenshots
      ) || return 1 ;;
    journey)
      (cd packages/backend && API_URL="$API_URL" pnpm test:journeys) || return 1 ;;
  esac
}

# Test integrity and lint, for the capability being built. Cheap, deterministic, and aimed at the two ways an agent
# can "pass" without being right: weakening a test, or leaving a scenario of the test plan untested.
scope_for() { # $1 = domain column → space-separated repo-relative test/code scope
  case "$(kind_of "$1")" in
    # The whole package: a capability such as S54 spans libs/common, libs/infrastructure, test/toolkit and the apps, and the
    # test titles carry the capability ID ("S54 AS-12: ..."), so a package-wide scan is precise and cheap.
    backend) echo "packages/backend" ;;
    web)     echo "packages/web" ;;
    journey) echo "packages/backend/test/journeys packages/web/tests" ;;
  esac
}

ownership_count() { # $1 = domain column: cross-domain table accesses reported inside that backend domain
  (cd packages/backend && NODE_ENV=test pnpm check:table-ownership 2>&1 || true) | grep -c "$(code_path "$1")/" || true
}

tx_count() { # $1 = domain column: direct Sequelize `.transaction(` call sites in non-test, non-comment code of that backend domain
  # (a Kafka producer.transaction() is not a database transaction, and a comment that mentions the call is not a call site)
  { grep -rn --include='*.ts' -E '[sS]equelize[A-Za-z]*\.transaction\(' "packages/backend/$(code_path "$1")" 2>/dev/null || true; } \
    | { grep -v -E '\.(e2e-)?spec\.ts' || true; } | { grep -v -E ':[0-9]+:[[:space:]]*(\*|//|/\*)' || true; } | grep -c . || true
}

# Run BEFORE gate(): everything here is static and takes seconds, while gate() spends ~7 minutes on the e2e suites. A missing scenario test,
# a lint error or a ratchet failure should show up at once, not after the e2e run (it cost two extra 7-minute runs on S53).
gate_extras() { # $1 = capability id, $2 = domain column, $3 = spec dir
  local id="$1" domain="$2" dir="$3" kind scope pkg files
  kind="$(kind_of "$domain")"; scope="$(scope_for "$domain")"
  python3 scripts/sdd/check-tests.py scenarios "$kind" "$dir/test-plan.md" "$id" $scope || return 1
  python3 scripts/sdd/check-tests.py integrity $scope || return 1
  # Lint ratchet: files this spec changed must be clean (formatting is auto-fixed first); old debt elsewhere is not our problem.
  pkg=packages/backend; [[ "$kind" == web ]] && pkg=packages/web
  files=$( { git diff --name-only --diff-filter=d HEAD -- "$pkg"; git ls-files --others --exclude-standard -- "$pkg"; } | grep -E '\.(ts|tsx)$' | sed "s|^$pkg/||" | sort -u || true)
  if [[ -n "$files" ]]; then
    # Errors on lines this capability added or changed fail the gate; old errors elsewhere in a touched file do not.
    local report arr; report="$(mktemp)"; mapfile -t arr <<<"$files"
    # --fix-type layout: formatting only. Unrestricted --fix once removed a type assertion that the compiler needed
    # (auctions/bid-relay.service.ts), and this step runs after the first tsc, so tsc runs again below.
    (cd "$pkg" && pnpm exec eslint --fix --fix-type layout --quiet --format json --output-file "$report" "${arr[@]}") || true
    python3 scripts/sdd/lint-changed.py "$report" || { rm -f "$report"; return 1; }
    rm -f "$report"
    (cd "$pkg" && npx tsc --noEmit -p tsconfig.json) || { echo "tsc failed after the lint fixes"; return 1; }
  fi
  # Ownership ratchet: a backend capability must not add cross-domain table accesses (baseline taken before the work started).
  # Transaction ratchet: direct sequelize transactions in this domain's code may not increase (S54 T037 follow-through).
  if [[ "$kind" == backend && -f "$dir/.tx.baseline" ]]; then
    local tnow tbase; tnow="$(tx_count "$domain")"; tbase="$(cat "$dir/.tx.baseline")"
    if (( tnow > tbase )); then echo "direct .transaction( sites in $(code_path "$domain"): $tnow (baseline $tbase); use TransactionRunner.run or @Transactional"; return 1; fi
  fi
  if [[ "$kind" == backend && -f "$dir/.ownership.baseline" ]]; then
    local now base; now="$(ownership_count "$domain")"; base="$(cat "$dir/.ownership.baseline")"
    if (( now > base )); then echo "check:table-ownership: $now findings in $(code_path "$domain") (baseline $base)"; return 1; fi
  fi
}

require_stack() { # web and journeys run against the local dev stack
  if ! curl -sf "$API_URL/health/ready" >/dev/null; then
    echo "STOP  $1 needs the local stack: moon run infra-setup && moon run dev-monolith (API_URL=$API_URL)" >&2
    exit 1
  fi
}

step() { # $1 = dir, $2 = step name, $3 = prompt
  # plan, tasks and analyze are one-shot per spec: a re-run (after a later failure) must not pay for them again.
  # Delete the .<step>.done marker to redo one.
  case "$2" in plan|tasks|analyze) [[ -f "$1/.$2.done" ]] && { echo "  $2 (done earlier)"; return 0; } ;; esac
  # Markers from a run on another machine may be missing (older runs did not commit them). A ticked task proves that plan, tasks
  # and analyze were finished: skip them, because redoing `tasks` could regenerate tasks.md and wipe the ticks.
  case "$2" in plan|tasks|analyze)
    if [[ -f "$1/tasks.md" ]] && grep -q -E '^- \[[xX]\]' "$1/tasks.md"; then
      touch "$1/.$2.done"; echo "  $2 (done earlier: tasks are already ticked)"; return 0
    fi ;; esac
  echo "  $2"
  local rc=0 try
  for try in 1 2; do
    rc=0; run_claude "$1/.$2.log" "$3" "${IMPL_TOOLS[@]}" || rc=$?
    (( rc == 0 || rc == 124 || rc == 125 )) && break
    hit_auth_failure "$1/.$2.log" && break
    hit_usage_limit "$1/.$2.log" && break
    (( try == 1 )) && { echo "  $2 failed; retrying once (transient errors happen)"; sleep 20; }
  done
  # A pass that hit the time limit is not a failure: the next implement pass resumes at the first open task.
  if (( rc == 124 )) && [[ "$2" == implement-* ]]; then echo "  $2 hit the pass timeout; the next pass resumes"; return 0; fi
  if (( rc == 125 )); then echo "deadline:$(basename "$1") at $2" > "$STATE_FILE"; exit 76; fi
  if (( rc != 0 )); then
    if hit_auth_failure "$1/.$2.log"; then echo "auth:$(basename "$1") $2 could not authenticate" > "$STATE_FILE"; exit 77; fi
    if hit_usage_limit "$1/.$2.log"; then echo "limit:$(basename "$1") $2 ($(limit_reset_hint "$1/.$2.log"))" > "$STATE_FILE"; exit 75; fi
    echo "FAIL  $(basename "$1"): $2 (see $1/.$2.log)" >&2; echo "$(basename "$1") failed at $2" > "$STATE_FILE"; exit 20
  fi
  case "$2" in plan|tasks|analyze) touch "$1/.$2.done" ;; esac
}

context_for() { # $1 = domain column
  local base='Inputs in the feature directory: spec.md, test-plan.md, gaps.md, and questions.md (its defaults are accepted as written; a line the human edited overrides spec.md). Constitution: .specify/memory/constitution.md. Token discipline (never at the cost of correctness): read only the files you need and only the relevant line ranges of large ones; run backend e2e specs through '"$TEST_SPEC"' <path-or-pattern> [jest args], which prints a condensed result (summary, failing test titles, assertion diffs) and the path of the full log, and open the full log only if the condensed output is not enough; run the narrowest test that proves the change, and the whole capability suite once at the end. If the same test still fails after 5 fix attempts, stop and write the blocker, what you tried and your hypothesis into questions.md instead of continuing.'
  case "$(kind_of "$1")" in
    backend) echo "$base Run backend commands from packages/backend." ;;
    web) echo "$base This is the Next.js app in packages/web: read packages/web/AGENTS.md and the relevant guide in packages/web/node_modules/next/dist/docs/ before writing code. Backend changes the UI needs go in packages/backend and follow the constitution (contracts in packages/contracts). The local dev stack is running (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/health/ready before re-running UI tests); Playwright starts the web dev server; run it with `--reporter=line --max-failures=1` and only the spec file for the page you changed until the final full run. Add test tooling the test plan needs (e.g. React Testing Library, widen the Vitest include)." ;;
    journey) echo "$base Journey tests go in packages/backend/test/journeys/<slug>.journey-spec.ts (see test/journeys/README.md) and run with pnpm test:journeys against the running local stack (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/health/ready). Fix broken hand-offs in the domain that owns them." ;;
  esac
}

# gate_digest <gate log>: the lines that explain why the gate failed, at most ~9000 characters (the log can be hundreds of KB).
gate_digest() {
  { grep -n -E '^(FAIL|Test Suites:|Tests:)|^ *●.*›|error TS[0-9]+|ESLint errors|^scenarios in test-plan|integrity|^check:|^direct \.transaction|tsc failed|^[A-Za-z0-9_./-]+:[0-9]+ ' "$1" | head -60
    echo '--- the last lines of the gate output ---'; tail -n 40 "$1"; } | cut -c1-240 | head -c 9000
}

# repair_prompt <gate log>: what the agent is told when the gate fails.
repair_prompt() {
  printf '%s\n%s' "The hard gate for this capability FAILED. Find the cause and fix it so the whole gate passes. Rules: never weaken, skip or delete a test; a test that fails outside this capability's own files is still a real failure (the code under it may be wrong, e.g. it can depend on the machine's time zone): fix the code and note it under a '## Gate repairs' heading in this spec's gaps.md; a scenario that test-plan.md says has a test must get a real test whose title starts with this capability's ID and the scenario (for example it('S53 AS-27: ...')), not just a tag; change nothing unrelated. Re-run the failing check yourself before you stop (scripts/sdd/test-spec.sh for e2e specs, npx tsc --noEmit, python3 scripts/sdd/check-tests.py ...). Gate output, digested:" "$(gate_digest "$1")"
}

# Rules that apply to every capability, plus follow-ups that already-built specs left for this one.
extra_context() { # $1 = capability id
  local fu; fu="$("$ROOT/scripts/sdd/followups.sh" "$1" 2>/dev/null || true)"
  printf ' %s' "Cross-spec rules. (1) Sibling follow-ups: if your work changes something another capability's spec relies on (a name, header, status code, contract), do not edit that spec; add a bullet '- **<their id>**: <what they must adopt>' under a '## Sibling-spec follow-ups' heading in this spec's gaps.md. (2) Unverified criteria: every success criterion (SC-nnn) that no automated test proves goes under 'Ops artifacts' in quickstart.md and as one row in specs/UNVERIFIED.md (spec, criterion, how to run it, status 'not run'); never describe it as verified. (3) Undoing work: never use git checkout, restore, reset, stash or clean (they are not available and could discard other work in the same file); to undo a change edit the file by hand and keep every other change in it, and if a task says to revert a file, restore only the lines it names. (4) Transactions: use TransactionRunner.run or @Transactional (S54 toolkit); when you touch a file that opens a transaction directly with sequelize.transaction, migrate that site and delete its '// S54 T037 audit' comment; never add a new direct sequelize.transaction (the gate fails if the count of direct sites in your domain rises)."
  if [[ -n "$fu" ]]; then printf ' %s\n%s' "Follow-ups left for this capability by specs that are already built; treat each as a requirement, plan it, test it, and mention it in your report:" "$fu"; fi
}

# ---- Self-repair. When a step inside one capability fails (a CRITICAL analysis finding, a stuck implement pass, a failed gate, a
# crashed step) the loop does not end the run. A separate repair agent with a fresh context gets a time budget to fix the cause, then
# the capability is retried. If the agent says a human is needed, or the budget is gone, the capability is marked BLOCKED (BLOCKED.md)
# and the loop moves on to the next capability that does not depend on it. REPAIR_BUDGET_MIN (60) is shared by the whole run,
# MAX_REPAIRS_PER_SPEC (2) bounds the attempts per capability, one attempt runs at most 25 minutes.
REPAIR_USED=0
BLOCKED_LIST="$(mktemp)"
declare -A DEPS
while read -r k v; do DEPS[$k]="$v"; done < <(python3 "$ROOT/scripts/sdd/check-order.py" --deps 2>/dev/null || true)

doctor_prompt() { # $1 = id, $2 = spec dir, $3 = what failed
  local log digest=""; log="$(ls -t "$2"/.*.log 2>/dev/null | head -1 || true)"
  if [[ -n "$log" ]]; then
    if [[ "$log" == *.gate.log ]]; then digest="$(gate_digest "$log")"; else digest="$(tail -c 5000 "$log")"; fi
  fi
  printf '%s\n%s' "You are the repair agent of an unattended build loop. A step failed for capability $1 and the loop cannot continue until it is fixed. What failed: $3. Find the root cause and fix it so the step can be retried. Work in the spec folder $2 (spec.md, plan.md, tasks.md, test-plan.md, gaps.md, questions.md) and in the code. Typical causes: (a) an analysis finding marked CRITICAL: fix the artifacts it points at (add the missing task, align spec, plan and tasks, resolve the contradiction); never delete or weaken a requirement or a test just to make the analysis pass; (b) two requirements that contradict each other: decide it as the constitution and the spec's own intent require, record the decision under a '## RESOLVED (agent decision)' heading in questions.md, and update spec.md and test-plan.md consistently; (c) a step that crashed or produced nothing: re-run the underlying command yourself and find the cause; (d) an implement pass that closed no task: do the blocked task yourself, or record why it needs a human. Rules: never use git to undo work (edit files by hand and keep every other change in them); never skip, weaken or delete a test; change nothing unrelated. End your final message with exactly one line: 'DOCTOR: fixed' if the loop can retry, or 'DOCTOR: needs human: <one sentence why>' if a human decision or access is needed. The end of the failing log follows." "$digest"
}

block_spec() { # $1 = id, $2 = spec dir, $3 = reason
  local f="$2/BLOCKED.md" last
  last="$(ls -t "$2"/.*.log 2>/dev/null | head -1 || true)"
  {
    echo "# $1 is blocked"; echo
    echo "- when: $(date -u +%FT%TZ)"
    echo "- why: $3"
    echo "- repair agent time used in this run: $((REPAIR_USED / 60)) of ${REPAIR_BUDGET_MIN:-60} minutes"; echo
    echo "## What to do"
    echo "Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this"
    echo "capability. Until then the loop skips it and everything that depends on it."; echo
    echo "## End of the last log (${last##*/})"; echo '```'
    [[ -n "$last" ]] && tail -c 3500 "$last"
    echo '```'
  } > "$f"
  printf '%s\t%s\n' "$1" "$3" >> "$BLOCKED_LIST"
  if [[ -n "${COMMIT:-}" ]]; then git add -A && git commit -q -m "blocked($1): $3" -m "See $f"; push_branch; fi
  notify warn "SDD: $1 blocked" "$3. The loop continues with the next capability."
  echo "BLOCKED  $1: $3"
}

ordered_capabilities "$@" | while IFS=$'\t' read -r id domain slug title sources limit; do
  if [[ "$id" == '!STOP' ]]; then # checkpoint: stop once so a human can test what exists, then pass on the next run
    marker="$ROOT/specs/.checkpoints/$domain"
    if [[ -f "$marker" ]]; then echo "pass  checkpoint $domain"; continue; fi
    # Before pausing: every earlier capability must still work (full e2e sweep) and the flow script, if any, must pass.
    if ! "$ROOT/scripts/sdd/checkpoint.sh" "$domain"; then
      echo "Checkpoint $domain FAILED its regression sweep or flow script (specs/.checkpoints/$domain.log)." > "$STATE_FILE"; exit 1
    fi
    mkdir -p "$ROOT/specs/.checkpoints"; date -u +%FT%TZ > "$marker"
    # Committed, so a fresh clone (the VPS runner) continues past this checkpoint instead of stopping at it forever.
    if [[ -n "${COMMIT:-}" ]]; then git add "$marker" && git commit -q -m "chore(sdd): checkpoint $domain reached" -m "$title" || true; push_branch; fi
    echo "CHECKPOINT $domain: $title"
    echo "Checkpoint $domain: $title  Test it, then re-run the same command to continue." > "$STATE_FILE"
    exit 0
  fi
  left="$(deadline_left)"
  if [[ -n "$left" ]] && (( left <= 0 )); then echo "deadline:the time budget ended before $id" > "$STATE_FILE"; echo "STOP  time budget used before $id" >&2; exit 76; fi
  dir="$(spec_dir "$domain" "$id" "$slug")"
  [[ -f "$dir/.spec-done" ]] || { echo "skip  $id (no finished spec yet)"; continue; }
  # An entry can be limited to a priority ("W02:P1" in the order file): the stories of that priority and higher now, the
  # rest in a later plain entry. Markers: .implemented (all of it) or .implemented-P1 (through P1).
  [[ "${limit:--}" == "-" ]] && limit="" 
  done_marker="$dir/.implemented${limit:+-$limit}"
  [[ -f "$dir/.implemented" || -f "$done_marker" ]] && { echo "skip  $id${limit:+ ($limit)} (already implemented)"; continue; }
  if [[ -f "$dir/BLOCKED.md" && -z "${RETRY_BLOCKED:-}" && -z "${GATE_ONLY:-}" ]]; then
    echo "skip  $id (blocked earlier, see $dir/BLOCKED.md; delete it to retry)"; printf '%s\t%s\n' "$id" "blocked earlier" >> "$BLOCKED_LIST"; continue
  fi
  skipdep=""
  for d in ${DEPS[$id]:-}; do grep -q "^$d"$'\t' "$BLOCKED_LIST" && skipdep="$d"; done
  if [[ -n "$skipdep" ]]; then echo "skip  $id (depends on the blocked $skipdep)"; printf '%s\t%s\n' "$id" "depends on blocked $skipdep" >> "$BLOCKED_LIST"; continue; fi
  LIMIT_TEXT=""
  if [[ -n "$limit" ]]; then
    LIMIT_TEXT="PRIORITY LIMIT: this pass covers only the user stories of priority $limit and higher (P1 is the highest), plus the Setup and Foundational phases. Implement those, red → green, exactly as before. Do not start the phases of lower-priority stories, do not tick their tasks, and leave the Polish, Cross-Cutting and Convergence phases for the final full pass. A scenario (AS-nn) that only a deferred story covers is deferred, not failed. Under a '## Deferred until a later pass' heading in this spec's gaps.md list the deferred stories and scenarios and, for each, the capability it waits for. If a story you do implement would call a capability that is not built yet (no .implemented marker in its spec folder), do not stub or fake it: build the part that does not need it, let the missing part degrade exactly as this spec's error handling requires (for example a section reported as unavailable), and list it under the same heading."
  fi
  # Build this entry. Inside the subshell, exit 20 means "this capability failed" (the repair agent gets a go); 75/76/77 end the run
  # (usage limit, time budget, login); 30 means UNTIL was reached.
  repair_tries=0; reached_until=""; blocked=""
  while :; do
  set +e   # a failing capability must not end the run by itself: its exit status is read below (errexit is back on inside the subshell)
  (
  set -e
  [[ "$(kind_of "$domain")" == backend ]] || require_stack "$id"
  if [[ -n "${GATE_ONLY:-}" ]]; then # re-run just the gate (no claude, no marker, no commit): GATE_ONLY=1 scripts/sdd/implement-specs.sh S54
    echo "gate-only $id"
    if { MAX_PRIORITY="$limit" gate_extras "$id" "$domain" "$dir" && MAX_PRIORITY="$limit" gate "$domain"; } >"$dir/.gate.log" 2>&1; then echo "GATE OK    $id${limit:+ ($limit)}"; else echo "GATE FAIL  $id (see $dir/.gate.log)"; fi
    exit 0
  fi
  echo "build $id${limit:+ ($limit only)} — $title"
  if [[ "$(kind_of "$domain")" == backend && ! -f "$dir/.ownership.baseline" ]]; then ownership_count "$domain" > "$dir/.ownership.baseline"; fi
  if [[ "$(kind_of "$domain")" == backend && ! -f "$dir/.tx.baseline" ]]; then tx_count "$domain" > "$dir/.tx.baseline"; fi
  printf '{\n  "feature_directory": "%s"\n}\n' "$dir" > .specify/feature.json
  CONTEXT="$(context_for "$domain")$(extra_context "$id")"

  step "$dir" plan "/speckit-plan $CONTEXT Include every gaps.md item (code fixes and constitution debt) in the plan."
  step "$dir" tasks "/speckit-tasks $CONTEXT Order tasks test-first: for each test-plan.md row, the failing test task comes before the code task. Every gaps.md item gets a task."
  step "$dir" analyze "/speckit-analyze $CONTEXT"
  # Only a CRITICAL in the Severity column of the findings table counts; the report also says "no CRITICAL issues".
  if grep -qE '^\|[^|]*\|[^|]*\| *\**CRITICAL\** *\|' "$dir/.analyze.log"; then
    echo "STOP  $id: /speckit-analyze reported CRITICAL issues (see $dir/.analyze.log)" >&2; echo "$id: analyze reported CRITICAL issues" > "$STATE_FILE"; rm -f "$dir/.analyze.done"; exit 20
  fi
  # One `claude -p` call cannot finish a big spec: it stops when its budget (STEP_MAX_BUDGET_USD) runs out, with its
  # context full. So implement runs in passes, each with a fresh context that resumes at the first unchecked task,
  # until nothing is open and converge adds nothing. A pass that closes no task stops the run (stuck, not slow).
  open_tasks() { python3 "$ROOT/scripts/sdd/tasks-scope.py" "$dir/tasks.md" "${limit:--}" | awk '{print $2}'; }
  IMPL_RULES='Work red → green: name every test with its capability and scenario, e.g. it('\''S13 AS-12: ...'\'') (the gate checks that every scenario of test-plan.md that names a test has one); run each new test and watch it fail before writing the code, then make it pass. Do not weaken or skip a test to make it pass; if a spec requirement looks wrong, record it in questions.md and stop. If something this spec Requires from another capability (its Cross-capability contracts section or gaps.md) does not exist yet, build the minimal provider side in the owning domain exactly as that capability'\''s spec defines it (or as this spec states it, if that spec is not written yet), exported through that domain'\''s index.ts and covered by its own e2e test, and note it in gaps.md; never read or write the other domain'\''s tables instead (constitution IX.4).'
  pass=0; last_open=999999; open=$(open_tasks)
  while (( pass < ${MAX_IMPLEMENT_PASSES:-10} )); do
    pass=$((pass + 1))
    if (( pass == 1 )); then lead="Implement the tasks."; else lead="Resume: tasks already checked are done; continue at the first unchecked task in tasks.md (some may be partly built: inspect the code first)."; fi
    if (( pass == 1 && open == 0 )); then echo "  implement skipped: no open task"
    else step "$dir" "implement-$pass" "/speckit-implement $CONTEXT $lead $IMPL_RULES $LIMIT_TEXT"; fi
    open=$(open_tasks)
    if (( open == 0 )); then
      step "$dir" "converge-$pass" "/speckit-converge $CONTEXT $LIMIT_TEXT"
      open=$(open_tasks)
      (( open == 0 )) && break
      echo "  converge added tasks: $open open"
    elif (( open >= last_open )); then
      echo "$id: implement stuck at pass $pass" > "$STATE_FILE"; echo "STOP  $id: implement pass $pass closed no task ($open still open). See $dir/.implement-$pass.log and questions.md" >&2; exit 20
    else
      echo "  $open task(s) still open after pass $pass"
    fi
    last_open=$open
  done
  if (( open > 0 )); then
    echo "$id: $open task(s) still open after $pass passes" > "$STATE_FILE"; echo "STOP  $id: $open task(s) still open after $pass passes (MAX_IMPLEMENT_PASSES)." >&2; exit 20
  fi

  # The gate is a hard check, but a failing gate is usually fixable (a missing test, a lint error, a bug the capability exposed):
  # hand the failure to the agent, then run the gate again. MAX_GATE_REPAIRS (default 2) bounds the attempts.
  attempt=0
  while :; do
    echo "  gate"
    if { MAX_PRIORITY="$limit" gate_extras "$id" "$domain" "$dir" && MAX_PRIORITY="$limit" gate "$domain"; } >"$dir/.gate.log" 2>&1; then break; fi
    attempt=$((attempt + 1))
    if (( attempt > ${MAX_GATE_REPAIRS:-2} )); then
      echo "FAIL  $id: gate (see $dir/.gate.log)" >&2; echo "$id gate failed" > "$STATE_FILE"; exit 20
    fi
    echo "  gate failed: asking the agent to repair it (attempt $attempt of ${MAX_GATE_REPAIRS:-2})"
    step "$dir" "repair-$attempt" "/speckit-implement $CONTEXT $(repair_prompt "$dir/.gate.log") $LIMIT_TEXT"
  done
  date -u +%FT%TZ > "$done_marker"
  if [[ -n "${COMMIT:-}" ]]; then
    git add -A && git commit -q -m "feat($domain): $id $title${limit:+ ($limit stories)}" -m "Spec: $dir/spec.md"
    push_branch
    echo "  committed"
  fi
  echo "done  $id${limit:+ ($limit)}"
  echo "$id${limit:+ ($limit)} built" > "$STATE_FILE"
  if [[ -n "${UNTIL:-}" && ( "$id" == "$UNTIL" || "$id:$limit" == "$UNTIL" ) ]]; then echo "reached UNTIL=$UNTIL, stopping"; echo "Reached UNTIL=$UNTIL." > "$STATE_FILE"; exit 30; fi
  )
  rc=$?
  set -e
  case $rc in
    0) break ;;
    30) reached_until=1; break ;;
    20) ;;
    *) exit "$rc" ;;
  esac
  detail="$(cat "$STATE_FILE" 2>/dev/null)"
  repair_tries=$((repair_tries + 1))
  budget_left=$(( ${REPAIR_BUDGET_MIN:-60} * 60 - REPAIR_USED ))
  if (( repair_tries <= ${MAX_REPAIRS_PER_SPEC:-2} && budget_left >= 120 )); then
    cap=$(( budget_left < 1500 ? budget_left : 1500 )); t0=$SECONDS
    echo "  repair agent for $id: $detail (repair budget left: $((budget_left / 60)) min)"
    ( export PASS_TIMEOUT_S=$cap; step "$dir" "doctor-$repair_tries" "$(doctor_prompt "$id" "$dir" "$detail")" ) && drc=0 || drc=$?
    REPAIR_USED=$(( REPAIR_USED + SECONDS - t0 ))
    case $drc in 75|76|77) exit "$drc" ;; esac
    if (( drc == 0 )); then
      if grep -q "DOCTOR: needs human" "$dir/.doctor-$repair_tries.log" 2>/dev/null; then
        detail="needs a human: $(grep -o 'DOCTOR: needs human:.*' "$dir/.doctor-$repair_tries.log" | head -1 | cut -c1-300)"
      else
        echo "  repair agent finished; retrying $id"; continue
      fi
    fi
  fi
  block_spec "$id" "$dir" "$detail"; blocked=1; break
  done
  if [[ -n "$reached_until" ]]; then echo "reached UNTIL=$UNTIL, stopping"; break; fi
  if [[ -n "$blocked" ]]; then continue; fi   # (not `[[ ]] && continue`: that returns 1 as the last command and made a good run exit 1)
done
if [[ -s "$BLOCKED_LIST" ]]; then
  echo "blocked:$(cut -f1 "$BLOCKED_LIST" | sort -u | tr '\n' ' ')" > "$STATE_FILE"
  exit 78
fi

