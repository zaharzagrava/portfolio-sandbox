#!/usr/bin/env bash
# Delete runner machines older than N hours (default 8), a safety net next to the machine's own timers.
#   scripts/vps/cleanup.sh [hours] [--all]      --all deletes every runner and build machine regardless of age
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/vps/lib.sh"
load_config; require_tools hcloud
hours="${1:-8}"; all=""; [[ "${2:-}" == "--all" || "${1:-}" == "--all" ]] && all=1; [[ "$hours" == "--all" ]] && hours=8
now=$(date +%s); n=0
while read -r name created; do
  [[ -n "$name" ]] || continue
  age=$(( (now - $(date -d "$created" +%s)) / 3600 ))
  if [[ -n "$all" ]] || (( age >= hours )); then say "deleting $name (${age}h old)"; run hcloud server delete "$name"; n=$((n+1)); fi
done < <(hcloud server list --selector sdd-runner -o noheader -o columns=name,created)
say "deleted $n machine(s)"
