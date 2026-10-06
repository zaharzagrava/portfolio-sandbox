#!/usr/bin/env bash
# Sequential implementation (docs/architecture/sdd-runbook.md, step 4). For each written spec, in catalog
# order (backend S…, then web W…, then journeys J…): plan → tasks → analyze → implement → converge
# (→ implement again if converge added tasks), then a hard gate for that kind of capability. Stops at the
# first failure so a human can step in; re-running resumes, because finished specs carry `.implemented`.
#
#   scripts/sdd/implement-specs.sh              # every spec that has spec.md and no .implemented
#   scripts/sdd/implement-specs.sh S10 orders   # filter by IDs and/or domain columns (also `web`, `journeys`)
#   COMMIT=1 scripts/sdd/implement-specs.sh     # commit after each green spec (recommended)
#
# Prerequisites (runbook step 4):
#   backend (S): the e2e test stores are up: `docker compose -f docker-compose.test.yaml up -d` (repo root)
#   web (W) and journeys (J): also the local dev stack: `moon run :infra-up`, `moon run :infra-setup`,
#     `moon run :dev-monolith` (API on $API_URL, watch mode). Playwright starts the web dev server itself.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
cd "$ROOT"
API_URL="${API_URL:-http://localhost:8000}"

# Implementation needs to build and run tests, on top of the file tools in lib.sh.
IMPL_TOOLS=('Bash(npx tsc:*)' 'Bash(npx jest:*)' 'Bash(npx nest build:*)' 'Bash(npx vitest:*)' 'Bash(npx playwright:*)'
            'Bash(pnpm:*)' 'Bash(node:*)' 'Bash(docker compose:*)' 'Bash(curl:*)'
            'Bash(cd:*)' 'Bash(cat:*)' 'Bash(grep:*)' 'Bash(find:*)' 'Bash(git log:*)')

# Where a backend capability's code and e2e specs live, relative to packages/backend.
code_path() {
  case "$1" in
    infrastructure) echo "libs/infrastructure" ;;
    composition)    echo "libs/composition" ;;
    *)              echo "libs/domains/$1" ;;
  esac
}

# Every kind runs this: web and journey work may change backend code too.
backend_core_gate() {
  (
    cd packages/backend
    rm -f tsconfig.tsbuildinfo
    npx tsc --noEmit -p tsconfig.json
    npx jest --ci
    NODE_ENV=test pnpm check:module-graph      # one process per app: barrel cycles that tsc can't see
    NODE_ENV=test pnpm check:model-registry    # every app's Sequelize models wire their associations
    pnpm check:boundaries                      # constitution X.4/X.5/X.8 (dependency-cruiser)
  )
}

gate() { # $1 = domain column; everything must pass
  backend_core_gate
  case "$(kind_of "$1")" in
    backend)
      (cd packages/backend && npx jest --ci --config jest-e2e.json "$(code_path "$1")") ;;
    web)
      (
        cd packages/web
        npx tsc --noEmit -p tsconfig.json
        pnpm test                               # Vitest: UI-only logic, component states, a11y
        API_URL="$API_URL" pnpm test:e2e        # Playwright: happy-path journeys + layout screenshots
      ) ;;
    journey)
      (cd packages/backend && API_URL="$API_URL" pnpm test:journeys) ;;
  esac
}

require_stack() { # web and journeys run against the local dev stack
  if ! curl -sf "$API_URL/readyz" >/dev/null; then
    echo "STOP  $1 needs the local stack: moon run :infra-up && moon run :infra-setup && moon run :dev-monolith (API_URL=$API_URL)" >&2
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
  local base='Inputs in the feature directory: spec.md, test-plan.md, gaps.md, and questions.md (its defaults are accepted as written; a line the human edited overrides spec.md). Constitution: .specify/memory/constitution.md.'
  case "$(kind_of "$1")" in
    backend) echo "$base Run backend commands from packages/backend." ;;
    web) echo "$base This is the Next.js app in packages/web: read packages/web/AGENTS.md and the relevant guide in packages/web/node_modules/next/dist/docs/ before writing code. Backend changes the UI needs go in packages/backend and follow the constitution (contracts in packages/contracts). The local dev stack is running (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz before re-running UI tests); Playwright starts the web dev server. Add test tooling the test plan needs (e.g. React Testing Library, widen the Vitest include)." ;;
    journey) echo "$base Journey tests go in packages/backend/test/journeys/<slug>.journey-spec.ts (see test/journeys/README.md) and run with pnpm test:journeys against the running local stack (API at $API_URL, watch mode: after backend edits wait for GET $API_URL/readyz). Fix broken hand-offs in the domain that owns them." ;;
  esac
}

for_each_capability "$@" | while IFS=$'\t' read -r id domain slug title sources; do
  dir="$(spec_dir "$domain" "$id" "$slug")"
  [[ -f "$dir/.spec-done" ]] || { echo "skip  $id (no finished spec yet)"; continue; }
  [[ -f "$dir/.implemented" ]] && { echo "skip  $id (already implemented)"; continue; }
  [[ "$(kind_of "$domain")" == backend ]] || require_stack "$id"
  echo "build $id — $title"
  printf '{\n  "feature_directory": "%s"\n}\n' "$dir" > .specify/feature.json
  CONTEXT="$(context_for "$domain")"

  step "$dir" plan "/speckit-plan $CONTEXT Include every gaps.md item (code fixes and constitution debt) in the plan."
  step "$dir" tasks "/speckit-tasks $CONTEXT Order tasks test-first: for each test-plan.md row, the failing test task comes before the code task. Every gaps.md item gets a task."
  step "$dir" analyze "/speckit-analyze $CONTEXT"
  if grep -q 'CRITICAL' "$dir/.analyze.log"; then
    echo "STOP  $id: /speckit-analyze reported CRITICAL issues (see $dir/.analyze.log)" >&2; exit 1
  fi
  step "$dir" implement "/speckit-implement $CONTEXT Work red → green: run each new test and watch it fail before writing the code, then make it pass. Do not weaken or skip a test to make it pass; if a spec requirement looks wrong, record it in questions.md and stop. If something this spec Requires from another capability (its Cross-capability contracts section or gaps.md) does not exist yet, build the minimal provider side in the owning domain exactly as that capability's spec defines it (or as this spec states it, if that spec is not written yet), exported through that domain's index.ts and covered by its own e2e test, and note it in gaps.md; never read or write the other domain's tables instead (constitution IX.4)."
  tasks_before=$(grep -c '^- \[ \]' "$dir/tasks.md" || true)
  step "$dir" converge "/speckit-converge $CONTEXT"
  if (( $(grep -c '^- \[ \]' "$dir/tasks.md" || true) > 0 )); then
    echo "  converge left $(grep -c '^- \[ \]' "$dir/tasks.md") open task(s) (was $tasks_before): implementing again"
    step "$dir" implement-2 "/speckit-implement $CONTEXT Complete the remaining unchecked tasks, red → green."
  fi

  echo "  gate"
  if ! gate "$domain" >"$dir/.gate.log" 2>&1; then
    echo "FAIL  $id: gate (see $dir/.gate.log)" >&2; exit 1
  fi
  date -u +%FT%TZ > "$dir/.implemented"
  if [[ -n "${COMMIT:-}" ]]; then
    git add -A && git commit -q -m "feat($domain): $id $title" -m "Spec: $dir/spec.md"
    echo "  committed"
  fi
  echo "done  $id"
done
