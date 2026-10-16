#!/usr/bin/env bash
# Does every deployable app boot on its own (L-015, L-018)? The monolith supplies modules and settings that a standalone app lacks.
#   scripts/infra/boot-apps.sh [app ...]    default: core worker projector payment-processor sse-gateway
# Starts each app on its own port, waits for /health/ready, reports, stops it. Exit 1 when any app is not ready (the first Nest errors are printed).
# The dev stack must be up. BOOT_WAIT (seconds per app, default 180).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT/packages/backend"
declare -A PORTS=([core]=8010 [worker]=8003 [projector]=8002 [payment-processor]=8011 [sse-gateway]=8001)
APPS=("$@"); [[ ${#APPS[@]} -eq 0 ]] && APPS=(core worker projector payment-processor sse-gateway)
WAIT="${BOOT_WAIT:-180}"; fail=0
for app in "${APPS[@]}"; do
  port="${PORTS[$app]:?unknown app $app}"
  log="$(mktemp -t "boot-$app.XXXXXX.log")"
  NODE_ENV=local PORT="$port" setsid npx nest start "$app" >"$log" 2>&1 &
  pid=$!
  ok=no
  for ((i = 0; i < WAIT; i += 3)); do
    curl -sf "http://localhost:$port/health/ready" >/dev/null 2>&1 && { ok=yes; break; }
    sleep 3
  done
  echo "$app port=$port ready=$ok log=$log"
  if [[ $ok = no ]]; then
    fail=1
    sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -m5 -E "Nest can't resolve|UnknownDependencies|ERROR|error TS|Cannot find module|Config validation|Error:" | cut -c1-300
  fi
  pkill -P "$pid" 2>/dev/null; kill -- "-$pid" 2>/dev/null; kill "$pid" 2>/dev/null
  sleep 2
done
exit $fail
