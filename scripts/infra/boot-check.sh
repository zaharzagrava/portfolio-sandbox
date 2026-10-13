#!/usr/bin/env bash
# Does the monolith boot? The per-capability gates test with their own small modules and never start the whole application, so a wiring mistake (a provider that a module
# does not import, a projector whose stores are not re-exported) passes every gate and then stops the API at startup (found on the first cloud run, 2026-10-13).
#   scripts/infra/boot-check.sh [--wait SECONDS] [--start]       exit 0 = ready; exit 1 = not ready, and the Nest errors that stopped it are printed
#   --start   start `start:dev:monolith` when nothing answers (and stop it again afterwards); without it, only judge an API that is already starting or running
# The dev stack must be up. API_URL (default http://localhost:8000), API_LOG (the log of the running API; default: a new file when --start).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
API_URL="${API_URL:-http://localhost:8000}"; WAIT=120; START=""
while [[ $# -gt 0 ]]; do case "$1" in --wait) WAIT="$2"; shift 2 ;; --start) START=1; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
ready() { curl -sf "$API_URL/health/ready" >/dev/null 2>&1; }
pid=""; log="${API_LOG:-}"
if ! ready && [[ -n "$START" ]]; then
  log="${log:-$(mktemp -t api-boot.XXXXXX.log)}"
  (cd "$ROOT" && setsid pnpm --filter api run start:dev:monolith >"$log" 2>&1 & echo $! > "$log.pid"); pid="$(cat "$log.pid")"
fi
for ((i = 0; i < WAIT; i += 3)); do ready && break; sleep 3; done
if ready; then
  [[ -n "$pid" ]] && { kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null; }
  echo "boot-check: the monolith is ready"; exit 0
fi
echo "boot-check: the monolith is NOT ready after ${WAIT}s${log:+ (log: $log)}" >&2
if [[ -n "$log" && -f "$log" ]]; then
  # the first error is the cause; what follows is noise
  sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -m6 -E "UnknownDependenciesException|Nest can't resolve|ERROR \[|error TS[0-9]+|Cannot find module|Error: " | cut -c1-400 >&2
fi
[[ -n "$pid" ]] && { kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null; }
exit 1
