#!/usr/bin/env bash
# Sequential implementation (docs/architecture/sdd-runbook.md, step 4). For each written spec, in the order of
# scripts/sdd/implement-order.txt (platform, identity, money chain, resume-featured, ..., web, journeys): plan → tasks → analyze → implement → converge
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
  if [[ "$state" == limit:* ]]; then
    echo "OUT OF BUDGET  the Claude usage limit was reached at ${state#limit:}. Nothing is lost: re-run the same command after the limit resets and it resumes." >&2
    notify limit "SDD loop: out of budget" "Usage limit hit at ${state#limit:}. Re-run after the reset to resume."
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
            'Bash(pnpm:*)' 'Bash(node:*)' 'Bash(docker compose:*)' 'Bash(curl:*)'
            'Bash(cd:*)' 'Bash(cat:*)' 'Bash(grep:*)' 'Bash(find:*)' 'Bash(git log:*)')

# for_each_capability, re-sorted by implement-order.txt (IDs not listed there come last, in catalog order).
ordered_capabilities() {
  for_each_capability "$@" | awk -F'\t' -v order="$ROOT/scripts/sdd/implement-order.txt" '
    BEGIN { while ((getline line < order) > 0) { if (line ~ /^#/ || line ~ /^[[:space:]]*$/) continue; pos[line] = ++n } }
    { print (($1 in pos) ? pos[$1] : 100000 + NR) "\t" $0 }
  ' | sort -n -k1,1 | cut -f2-
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

tx_count() { # $1 = domain column: direct `.transaction(` call sites in non-test code of that backend domain
  { grep -rn --include='*.ts' -E '\.transaction\(' "packages/backend/$(code_path "$1")" 2>/dev/null || true; } | { grep -v -E '\.(e2e-)?spec\.ts' || true; } | grep -c . || true
}

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
  if ! curl -sf "$API_URL/readyz" >/dev/null; then
    echo "STOP  $1 needs the local stack: moon run infra-setup && moon run dev-monolith (API_URL=$API_URL)" >&2
    exit 1
  fi
}

step() { # $1 = dir, $2 = step name, $3 = prompt
  # plan, tasks and analyze are one-shot per spec: a re-run (after a later failure) must not pay for them again.
  # Delete the .<step>.done marker to redo one.
  case "$2" in plan|tasks|analyze) [[ -f "$1/.$2.done" ]] && { echo "  $2 (done earlier)"; return 0; } ;; esac
  echo "  $2"
  local rc=0
  run_claude "$1/.$2.log" "$3" "${IMPL_TOOLS[@]}" || rc=$?
  # A pass that hit the time limit is not a failure: the next implement pass resumes at the first open task.
  if (( rc == 124 )) && [[ "$2" == implement-* ]]; then echo "  $2 hit the pass timeout; the next pass resumes"; return 0; fi
  if (( rc != 0 )); then
    if hit_usage_limit "$1/.$2.log"; then echo "limit:$(basename "$1") $2 ($(limit_reset_hint "$1/.$2.log"))" > "$STATE_FILE"; exit 75; fi
    echo "FAIL  $(basename "$1"): $2 (see $1/.$2.log)" >&2; echo "$(basename "$1") failed at $2" > "$STATE_FILE"; exit 1
  fi
  case "$2" in plan|tasks|analyze) touch "$1/.$2.done" ;; esac
}

context_for() { # $1 = domain column
  local base='Inputs in the feature directory: spec.md, test-plan.md, gaps.md, and questions.md (its defaults are accepted as written; a line the human edited overrides spec.md). Constitution: .specify/memory/constitution.md. Token discipline (never at the cost of correctness): read only the files you need and only the relevant line ranges of large ones; run backend e2e specs through '"$TEST_SPEC"' <path-or-pattern> [jest args], which prints a condensed result (summary, failing test titles, assertion diffs) and the path of the full log, and open the full log only if the condensed output is not enough; run the narrowest test that proves the change, and the whole capability suite once at the end. If the same test still fails after 5 fix attempts, stop and write the blocker, what you tried and your hypothesis into questions.md instead of continuing.'
  case "$(kind_of "$1")" in
    backend) echo "$base Run backend commands from packages/backend." ;;
    web) echo "$base This is the Next.js app in packages/web: read packages/web/AGENTS.md and the relevant guide in packages/web/node_modules/next/dist/docs/ before writing code. Backend changes the UI needs go in packages/backend and follow the constitution (contracts in packages/contracts). The local dev stack is running (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz before re-running UI tests); Playwright starts the web dev server; run it with `--reporter=line --max-failures=1` and only the spec file for the page you changed until the final full run. Add test tooling the test plan needs (e.g. React Testing Library, widen the Vitest include)." ;;
    journey) echo "$base Journey tests go in packages/backend/test/journeys/<slug>.journey-spec.ts (see test/journeys/README.md) and run with pnpm test:journeys against the running local stack (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz). Fix broken hand-offs in the domain that owns them." ;;
  esac
}

# Rules that apply to every capability, plus follow-ups that already-built specs left for this one.
extra_context() { # $1 = capability id
  local fu; fu="$("$ROOT/scripts/sdd/followups.sh" "$1" 2>/dev/null || true)"
  printf ' %s' "Cross-spec rules. (1) Sibling follow-ups: if your work changes something another capability's spec relies on (a name, header, status code, contract), do not edit that spec; add a bullet '- **<their id>**: <what they must adopt>' under a '## Sibling-spec follow-ups' heading in this spec's gaps.md. (2) Unverified criteria: every success criterion (SC-nnn) that no automated test proves goes under 'Ops artifacts' in quickstart.md and as one row in specs/UNVERIFIED.md (spec, criterion, how to run it, status 'not run'); never describe it as verified. (3) Transactions: use TransactionRunner.run or @Transactional (S54 toolkit); when you touch a file that opens a transaction directly with sequelize.transaction, migrate that site and delete its '// S54 T037 audit' comment; never add a new direct sequelize.transaction (the gate fails if the count of direct sites in your domain rises)."
  if [[ -n "$fu" ]]; then printf ' %s\n%s' "Follow-ups left for this capability by specs that are already built; treat each as a requirement, plan it, test it, and mention it in your report:" "$fu"; fi
}

ordered_capabilities "$@" | while IFS=$'\t' read -r id domain slug title sources; do
  dir="$(spec_dir "$domain" "$id" "$slug")"
  [[ -f "$dir/.spec-done" ]] || { echo "skip  $id (no finished spec yet)"; continue; }
  [[ -f "$dir/.implemented" ]] && { echo "skip  $id (already implemented)"; continue; }
  [[ "$(kind_of "$domain")" == backend ]] || require_stack "$id"
  if [[ -n "${GATE_ONLY:-}" ]]; then # re-run just the gate (no claude, no marker, no commit): GATE_ONLY=1 scripts/sdd/implement-specs.sh S54
    echo "gate-only $id"
    if { gate "$domain" && gate_extras "$id" "$domain" "$dir"; } >"$dir/.gate.log" 2>&1; then echo "GATE OK    $id"; else echo "GATE FAIL  $id (see $dir/.gate.log)"; fi
    continue
  fi
  echo "build $id — $title"
  if [[ "$(kind_of "$domain")" == backend && ! -f "$dir/.ownership.baseline" ]]; then ownership_count "$domain" > "$dir/.ownership.baseline"; fi
  if [[ "$(kind_of "$domain")" == backend && ! -f "$dir/.tx.baseline" ]]; then tx_count "$domain" > "$dir/.tx.baseline"; fi
  printf '{\n  "feature_directory": "%s"\n}\n' "$dir" > .specify/feature.json
  CONTEXT="$(context_for "$domain")$(extra_context "$id")"

  step "$dir" plan "/speckit-plan $CONTEXT Include every gaps.md item (code fixes and constitution debt) in the plan."
  step "$dir" tasks "/speckit-tasks $CONTEXT Order tasks test-first: for each test-plan.md row, the failing test task comes before the code task. Every gaps.md item gets a task."
  step "$dir" analyze "/speckit-analyze $CONTEXT"
  # Only a CRITICAL in the Severity column of the findings table counts; the report also says "no CRITICAL issues".
  if grep -qE '^\|[^|]*\|[^|]*\| *\**CRITICAL\** *\|' "$dir/.analyze.log"; then
    echo "STOP  $id: /speckit-analyze reported CRITICAL issues (see $dir/.analyze.log)" >&2; echo "$id: analyze reported CRITICAL issues" > "$STATE_FILE"; exit 1
  fi
  # One `claude -p` call cannot finish a big spec: it stops when its budget (STEP_MAX_BUDGET_USD) runs out, with its
  # context full. So implement runs in passes, each with a fresh context that resumes at the first unchecked task,
  # until nothing is open and converge adds nothing. A pass that closes no task stops the run (stuck, not slow).
  open_tasks() { grep -c '^- \[ \]' "$dir/tasks.md" || true; }
  IMPL_RULES='Work red → green: name every test with its capability and scenario, e.g. it('\''S13 AS-12: ...'\'') (the gate checks that every scenario of test-plan.md that names a test has one); run each new test and watch it fail before writing the code, then make it pass. Do not weaken or skip a test to make it pass; if a spec requirement looks wrong, record it in questions.md and stop. If something this spec Requires from another capability (its Cross-capability contracts section or gaps.md) does not exist yet, build the minimal provider side in the owning domain exactly as that capability'\''s spec defines it (or as this spec states it, if that spec is not written yet), exported through that domain'\''s index.ts and covered by its own e2e test, and note it in gaps.md; never read or write the other domain'\''s tables instead (constitution IX.4).'
  pass=0; last_open=999999; open=$(open_tasks)
  while (( pass < ${MAX_IMPLEMENT_PASSES:-10} )); do
    pass=$((pass + 1))
    if (( pass == 1 )); then lead="Implement the tasks."; else lead="Resume: tasks already checked are done; continue at the first unchecked task in tasks.md (some may be partly built: inspect the code first)."; fi
    if (( pass == 1 && open == 0 )); then echo "  implement skipped: no open task"
    else step "$dir" "implement-$pass" "/speckit-implement $CONTEXT $lead $IMPL_RULES"; fi
    open=$(open_tasks)
    if (( open == 0 )); then
      step "$dir" "converge-$pass" "/speckit-converge $CONTEXT"
      open=$(open_tasks)
      (( open == 0 )) && break
      echo "  converge added tasks: $open open"
    elif (( open >= last_open )); then
      echo "$id: implement stuck at pass $pass" > "$STATE_FILE"; echo "STOP  $id: implement pass $pass closed no task ($open still open). See $dir/.implement-$pass.log and questions.md" >&2; exit 1
    else
      echo "  $open task(s) still open after pass $pass"
    fi
    last_open=$open
  done
  if (( open > 0 )); then
    echo "STOP  $id: $open task(s) still open after $pass passes (MAX_IMPLEMENT_PASSES). Re-run to continue." >&2; exit 1
  fi

  echo "  gate"
  if ! { gate "$domain" && gate_extras "$id" "$domain" "$dir"; } >"$dir/.gate.log" 2>&1; then
    echo "FAIL  $id: gate (see $dir/.gate.log)" >&2; echo "$id gate failed" > "$STATE_FILE"; exit 1
  fi
  date -u +%FT%TZ > "$dir/.implemented"
  if [[ -n "${COMMIT:-}" ]]; then
    git add -A && git commit -q -m "feat($domain): $id $title" -m "Spec: $dir/spec.md"
    echo "  committed"
  fi
  echo "done  $id"
  echo "$id built" > "$STATE_FILE"
  if [[ -n "${UNTIL:-}" && "$id" == "$UNTIL" ]]; then echo "reached UNTIL=$UNTIL, stopping"; echo "Reached UNTIL=$UNTIL." > "$STATE_FILE"; break; fi
done
