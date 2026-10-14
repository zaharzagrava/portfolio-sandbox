#!/usr/bin/env bash
# Start ONE real application of packages/backend/apps on its own (not the monolith), wait until it is up, show what it logged about its consumers and jobs, stop it.
# An unattended agent cannot approve "start a long-running server", so a task like "the real apps/projector boots and logs its registrations" (S19 T072, S36 T060, S39 T063) is
# closed with this script. The dev stack must be up (the runner's own, or scripts/qa/stack-up.sh).
#   scripts/infra/boot-app.sh <core|projector|worker|payment-processor|sse-gateway|collab|public-api|bff> [--wait SECONDS]
#   prints: "boot-app <app>: UP" and the log lines that mention consumers, jobs, mappings and registrations (the evidence a task asks for); the full log path is printed too.
#   exit 1 and the first Nest/TypeScript error when it does not come up.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT/packages/backend"
APP="${1:?usage: boot-app.sh <core|projector|worker|payment-processor|sse-gateway|collab|public-api|bff> [--wait SECONDS]}"; shift
WAIT=150; [[ "${1:-}" == "--wait" ]] && WAIT="$2"
case "$APP" in
  core)              SCRIPT=start:dev;                   PORT_=8010; EXTRA="PORT=8010" ;;
  payment-processor) SCRIPT=start:dev:payment-processor; PORT_=8011; EXTRA="PORT=8011" ;;
  sse-gateway)       SCRIPT=start:dev:sse-gateway;       PORT_=8001; EXTRA="" ;;
  projector)         SCRIPT=start:dev:projector;         PORT_=8002; EXTRA="" ;;
  worker)            SCRIPT=start:dev:worker;            PORT_=8003; EXTRA="" ;;
  collab)            SCRIPT=start:dev:collab;            PORT_=8004; EXTRA="" ;;
  public-api)        SCRIPT=start:dev:public-api;        PORT_=8005; EXTRA="" ;;
  bff)               SCRIPT=start:dev:bff;               PORT_=8006; EXTRA="" ;;
  *) echo "unknown app $APP" >&2; exit 2 ;;
esac
LOG="$(mktemp -t "boot-$APP.XXXXXX.log")"
( env $EXTRA setsid pnpm run "$SCRIPT" >"$LOG" 2>&1 & echo $! > "$LOG.pid" ); PID="$(cat "$LOG.pid")"
stop() { kill -- "-$PID" 2>/dev/null || kill "$PID" 2>/dev/null; sleep 1; pkill -P "$PID" 2>/dev/null || true; }
up=""
for ((i = 0; i < WAIT; i += 3)); do
  curl -sf "http://localhost:$PORT_/health/ready" >/dev/null 2>&1 && { up=1; break; }
  sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -qE "application successfully started|Nest application successfully|Application is running|listening on" && { up=1; break; }
  sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -qE "UnknownDependenciesException|Nest can't resolve|error TS[0-9]+|Cannot find module" && break
  sleep 3
done
sleep 4   # let the consumers and jobs register themselves
if [[ -n "$up" ]]; then
  echo "boot-app $APP: UP (log: $LOG)"
  sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -iE "consumer .* started|registered|job handlers|mapping|index .*(created|present)|subscribed|listening|started" | head -40 | cut -c1-240
  stop; exit 0
fi
echo "boot-app $APP: NOT UP after ${WAIT}s (log: $LOG)" >&2
sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -m6 -E "UnknownDependenciesException|Nest can't resolve|error TS[0-9]+|Cannot find module|Error: " | cut -c1-400 >&2
stop; exit 1
