#!/usr/bin/env bash
# Prints one line per important event of the SDD runner and nothing otherwise. Meant for a Claude Code Monitor (each line is an event) or a terminal.
#   scripts/vps/watch-runner.sh
# Events: a capability starting or done, STOP / BLOCKED / FAIL / crash, gate failed or not re-run, gate stages, doctor runs, pass timeouts,
# "needs human", a stalled loop.log (30 min without a change), a vanished machine, an unreachable machine, the runner script's own failure line.
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
source scripts/vps/lib.sh; load_config; set -a; source ~/.config/sdd-vps/config.env; set +a
PAT='^done |^build |STOP|BLOCKED|^FAIL|crashed|gate failed|gate not re-run|gate stage|doctor-|hit the pass timeout|needs human|TIME BUDGET|reached UNTIL|CHECKPOINT|checkpoint'
seen=0; unreach=0; gone=0; lastvm=""; stalls=0
while true; do
  ip=$(hcloud server list -o noheader -o columns=ipv4 2>/dev/null | head -1)
  if [[ -z "$ip" ]]; then gone=$((gone+1)); (( gone == 2 )) && echo "RUNNER GONE: no machine exists (the run ended or the machine was deleted)"; sleep 60; continue; fi
  gone=0
  out=$(timeout 60 ssh -o ConnectTimeout=15 -o BatchMode=yes $SDD_SSH_OPTS root@"$ip" '
    f=/var/log/sdd/loop.log
    if [ -f $f ]; then
      grep -vE "^grep:|^cut:" $f | grep -aE "'"$PAT"'" | cut -c1-170 | awk "{print NR\"\t\"\$0}"
      age=$(( $(date +%s) - $(stat -c %Y $f) )); echo "AGE\t$age"
    else echo "NOLOOP\t$(tail -1 /var/log/sdd/vm-run.log | cut -c1-120)"; fi
    tail -1 /var/log/sdd/vm-run.log | grep -E "FAILED|ended with exit" | cut -c1-150 | sed "s/^/VMRUN\t/"' 2>/dev/null)
  if [[ -z "$out" ]]; then unreach=$((unreach+1)); (( unreach == 5 )) && echo "RUNNER UNREACHABLE for 5 minutes (ssh fails)"; sleep 60; continue; fi
  unreach=0
  total=$(echo "$out" | grep -cP '^\d+\t')
  if (( total < seen )); then seen=0; fi
  echo "$out" | awk -F'\t' -v s="$seen" '/^[0-9]+\t/ && $1 > s {print $2}'
  seen=$total
  age=$(echo "$out" | awk -F'\t' '/^AGE/{print $2}')
  if [[ -n "$age" ]] && (( age > 1800 )); then stalls=$((stalls+1)); (( stalls % 10 == 1 )) && echo "STALL: loop.log has not changed for $((age/60)) minutes"; else stalls=0; fi
  vm=$(echo "$out" | grep -E '^VMRUN' | head -1)
  if [[ -n "$vm" && "$vm" != "$lastvm" ]]; then echo "$vm"; lastvm="$vm"; fi
  sleep 60
done
