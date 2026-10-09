#!/usr/bin/env bash
# Open the runner's tmux session (loop, monitor and stack logs). Ctrl-b d leaves it running.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/vps/lib.sh"
load_config; require_tools hcloud ssh
ip="$(hcloud server list --selector sdd-runner=run -o noheader -o columns=ipv4 | head -1)"
[[ -n "$ip" ]] || die "no runner machine exists (it deletes itself when the run ends)"
exec ssh -t $SDD_SSH_OPTS "root@$ip" 'tmux attach -t sdd || (tail -n 40 /var/log/sdd/vm-run.log; bash -l)'
