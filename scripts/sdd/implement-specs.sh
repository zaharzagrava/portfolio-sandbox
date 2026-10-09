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
#
# Prerequisites (runbook step 4):
#   backend (S): the e2e test stores are up: `moon run infra-test-setup` (own terminal)
#   web (W) and journeys (J): also the local dev stack: `moon run infra-setup`,
#     `moon run dev-monolith` (API on $API_URL, watch mode). Playwright starts the web dev server itself.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
cd "$ROOT"
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
    npx jest --ci &&
    NODE_ENV=test pnpm check:module-graph &&      # one process per app: barrel cycles that tsc can't see
    NODE_ENV=test pnpm check:model-registry &&    # every app's Sequelize models wire their associations
    pnpm check:boundaries                         # constitution X.4/X.5/X.8 (dependency-cruiser)
  )
}

gate() { # $1 = domain column; everything must pass
  backend_core_gate || return 1
  case "$(kind_of "$1")" in
    backend)
      (cd packages/backend && npx jest --ci --config jest-e2e.json "$(code_path "$1")") || return 1 ;;
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
    backend) echo "packages/backend/$(code_path "$1")" ;;
    web)     echo "packages/web" ;;
    journey) echo "packages/backend/test/journeys packages/web/tests" ;;
  esac
}

ownership_count() { # $1 = domain column: cross-domain table accesses reported inside that backend domain
  (cd packages/backend && NODE_ENV=test pnpm check:table-ownership 2>&1 || true) | grep -c "$(code_path "$1")/" || true
}

gate_extras() { # $1 = capability id, $2 = domain column, $3 = spec dir
  local id="$1" domain="$2" dir="$3" kind scope pkg files
  kind="$(kind_of "$domain")"; scope="$(scope_for "$domain")"
  python3 scripts/sdd/check-tests.py scenarios "$kind" "$dir/test-plan.md" "$id" $scope || return 1
  python3 scripts/sdd/check-tests.py integrity $scope || return 1
  # Lint ratchet: files this spec changed must be clean (formatting is auto-fixed first); old debt elsewhere is not our problem.
  pkg=packages/backend; [[ "$kind" == web ]] && pkg=packages/web
  files=$( { git diff --name-only HEAD -- "$pkg"; git ls-files --others --exclude-standard -- "$pkg"; } | grep -E '\.(ts|tsx)$' | sed "s|^$pkg/||" | sort -u || true)
  if [[ -n "$files" ]]; then
    (cd "$pkg" && xargs pnpm exec eslint --fix --quiet <<<"$files") || return 1
  fi
  # Ownership ratchet: a backend capability must not add cross-domain table accesses (baseline taken before the work started).
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
  echo "  $2"
  if ! run_claude "$1/.$2.log" "$3" "${IMPL_TOOLS[@]}"; then
    echo "FAIL  $(basename "$1"): $2 (see $1/.$2.log)" >&2; exit 1
  fi
}

context_for() { # $1 = domain column
  local base='Inputs in the feature directory: spec.md, test-plan.md, gaps.md, and questions.md (its defaults are accepted as written; a line the human edited overrides spec.md). Constitution: .specify/memory/constitution.md. Token discipline (never at the cost of correctness): read only the files you need and only the relevant line ranges of large ones; run backend e2e specs through '"$TEST_SPEC"' <path-or-pattern> [jest args], which prints a condensed result (summary, failing test titles, assertion diffs) and the path of the full log, and open the full log only if the condensed output is not enough; run the narrowest test that proves the change, and the whole capability suite once at the end. If the same test still fails after 5 fix attempts, stop and write the blocker, what you tried and your hypothesis into questions.md instead of continuing.'
  case "$(kind_of "$1")" in
    backend) echo "$base Run backend commands from packages/backend." ;;
    web) echo "$base This is the Next.js app in packages/web: read packages/web/AGENTS.md and the relevant guide in packages/web/node_modules/next/dist/docs/ before writing code. Backend changes the UI needs go in packages/backend and follow the constitution (contracts in packages/contracts). The local dev stack is running (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz before re-running UI tests); Playwright starts the web dev server; run it with `--reporter=line --max-failures=1` and only the spec file for the page you changed until the final full run. Add test tooling the test plan needs (e.g. React Testing Library, widen the Vitest include)." ;;
    journey) echo "$base Journey tests go in packages/backend/test/journeys/<slug>.journey-spec.ts (see test/journeys/README.md) and run with pnpm test:journeys against the running local stack (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz). Fix broken hand-offs in the domain that owns them." ;;
  esac
}

ordered_capabilities "$@" | while IFS=$'\t' read -r id domain slug title sources; do
  dir="$(spec_dir "$domain" "$id" "$slug")"
  [[ -f "$dir/.spec-done" ]] || { echo "skip  $id (no finished spec yet)"; continue; }
  [[ -f "$dir/.implemented" ]] && { echo "skip  $id (already implemented)"; continue; }
  [[ "$(kind_of "$domain")" == backend ]] || require_stack "$id"
  echo "build $id — $title"
  if [[ "$(kind_of "$domain")" == backend && ! -f "$dir/.ownership.baseline" ]]; then ownership_count "$domain" > "$dir/.ownership.baseline"; fi
  printf '{\n  "feature_directory": "%s"\n}\n' "$dir" > .specify/feature.json
  CONTEXT="$(context_for "$domain")"

  step "$dir" plan "/speckit-plan $CONTEXT Include every gaps.md item (code fixes and constitution debt) in the plan."
  step "$dir" tasks "/speckit-tasks $CONTEXT Order tasks test-first: for each test-plan.md row, the failing test task comes before the code task. Every gaps.md item gets a task."
  step "$dir" analyze "/speckit-analyze $CONTEXT"
  if grep -q 'CRITICAL' "$dir/.analyze.log"; then
    echo "STOP  $id: /speckit-analyze reported CRITICAL issues (see $dir/.analyze.log)" >&2; exit 1
  fi
  step "$dir" implement "/speckit-implement $CONTEXT Work red → green: name every test with its capability and scenario, e.g. it('S13 AS-12: ...') (the gate checks that every scenario of test-plan.md that names a test has one); run each new test and watch it fail before writing the code, then make it pass. Do not weaken or skip a test to make it pass; if a spec requirement looks wrong, record it in questions.md and stop. If something this spec Requires from another capability (its Cross-capability contracts section or gaps.md) does not exist yet, build the minimal provider side in the owning domain exactly as that capability's spec defines it (or as this spec states it, if that spec is not written yet), exported through that domain's index.ts and covered by its own e2e test, and note it in gaps.md; never read or write the other domain's tables instead (constitution IX.4)."
  tasks_before=$(grep -c '^- \[ \]' "$dir/tasks.md" || true)
  step "$dir" converge "/speckit-converge $CONTEXT"
  if (( $(grep -c '^- \[ \]' "$dir/tasks.md" || true) > 0 )); then
    echo "  converge left $(grep -c '^- \[ \]' "$dir/tasks.md") open task(s) (was $tasks_before): implementing again"
    step "$dir" implement-2 "/speckit-implement $CONTEXT Complete the remaining unchecked tasks, red → green."
  fi

  echo "  gate"
  if ! { gate "$domain" && gate_extras "$id" "$domain" "$dir"; } >"$dir/.gate.log" 2>&1; then
    echo "FAIL  $id: gate (see $dir/.gate.log)" >&2; exit 1
  fi
  date -u +%FT%TZ > "$dir/.implemented"
  if [[ -n "${COMMIT:-}" ]]; then
    git add -A && git commit -q -m "feat($domain): $id $title" -m "Spec: $dir/spec.md"
    echo "  committed"
  fi
  echo "done  $id"
  if [[ -n "${UNTIL:-}" && "$id" == "$UNTIL" ]]; then echo "reached UNTIL=$UNTIL, stopping"; break; fi
done
