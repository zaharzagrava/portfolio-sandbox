#!/usr/bin/env bash
# A capability that adds a queue edits infra/docker/elasticmq/elasticmq.conf; the queue server reads it only when it starts, so readiness stays red ("queue:<name>": "down")
# until it is restarted. An unattended agent cannot approve `docker restart`, so this script does it (and is on the agents' allow-list). Found 2026-10-14: S42 spent four gate
# repairs on it. Restarts ONLY the queue server of the dev stack, then waits until the API says ready.
#   scripts/infra/reload-queues.sh [--wait SECONDS]
set -uo pipefail
WAIT=120; [[ "${1:-}" == "--wait" ]] && WAIT="$2"
c="$(docker ps --format '{{.Names}}' | grep -m1 payment_system_elasticmq || true)"
[[ -n "$c" ]] || { echo "no payment_system_elasticmq container: is the dev stack up?" >&2; exit 1; }
docker restart "$c" >/dev/null
for ((i = 0; i < WAIT; i += 3)); do
  r="$(curl -s -m 5 "${API_URL:-http://localhost:8000}/health/ready")"
  grep -q '"ready":true' <<<"$r" && { echo "queues reloaded; the API is ready"; exit 0; }
  sleep 3
done
echo "queue server restarted but the API is not ready after ${WAIT}s: $r" >&2
exit 1
