#!/usr/bin/env bash
# Watches a running scripts/sdd/implement-specs.sh from the outside, as a separate process, so it also notices when the
# loop itself dies. Quiet by design: it logs every finished task, and only notifies on milestones and on problems.
#
#   scripts/sdd/monitor.sh [ID|domain ...]    # same filters and UNTIL as the loop; run it next to the loop
#   scripts/sdd/monitor.sh --status [...]     # print the current progress once and exit (sends nothing)
#
# Progress = average over the specs this run has to build (those with a finished spec and no .implemented at start):
# a built spec counts 100%, a spec in progress counts ticked/total of its tasks.md.
#
# Notifications (see notify in lib.sh; sound only for warnings and the end, never per task):
#   info  milestone 25/50/75/100 %, and every recovery ("... resolved")
#   warn  stalled, one task running too long, loop process gone, disk almost full, a test container exited
# Every warning is a raise/clear pair: when the condition goes away you get a quiet "recovered" message with the
# time it lasted, so a raised alert always gets an ending.
#
# Settings (environment):
#   MONITOR_INTERVAL=60   seconds between checks          STALL_MIN=25      no file change and no tick for this long
#   TASK_WARN_MIN=45      one task open for this long     DISK_WARN_PCT=90  root disk usage
#   NTFY_TOPIC / NTFY_SERVER   phone notifications (lib.sh)    HEARTBEAT_URL   pinged every interval (dead-man's switch,
#   e.g. a healthchecks.io check: it alerts you when the pings stop, which covers a VM that died completely)
#   MONITOR_STATE=.sdd-monitor   state and progress.log      NOTIFY_DRY=1   print instead of notifying
set -uo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
cd "$ROOT"

INTERVAL="${MONITOR_INTERVAL:-60}"
STALL_MIN="${STALL_MIN:-25}"
TASK_WARN_MIN="${TASK_WARN_MIN:-45}"
DISK_WARN_PCT="${DISK_WARN_PCT:-90}"
STATE="${MONITOR_STATE:-$ROOT/.sdd-monitor}"
LOG="$STATE/progress.log"
mkdir -p "$STATE/flags"

now() { date +%s; }
mins() { echo $(( ($(now) - $1) / 60 )); }
say() { local line; line="$(date +%H:%M:%S) $*"; echo "$line" | tee -a "$LOG"; }
hm() { local m=$1; if (( m >= 60 )); then echo "$((m / 60))h$(printf '%02d' $((m % 60)))"; else echo "${m}m"; fi; }

# ---- scope: the specs this run builds, fixed at the first start so later restarts keep the same denominator ----
SCOPE="$STATE/scope.tsv"        # id <tab> dir
build_scope() {
  : > "$SCOPE"
  local id domain slug title sources dir
  while IFS=$'\t' read -r id domain slug title sources; do
    dir="$(spec_dir "$domain" "$id" "$slug")"
    [[ -f "$dir/.spec-done" && ! -f "$dir/.implemented" ]] && printf '%s\t%s\n' "$id" "$dir" >> "$SCOPE"
    [[ -n "${UNTIL:-}" && "$id" == "$UNTIL" ]] && break
  done < <(ordered_capabilities "$@")
}

ticked() { grep -c -E '^- \[[xX]\]' "$1/tasks.md" 2>/dev/null || true; }
total()  { grep -c -E '^- \[[ xX]\]' "$1/tasks.md" 2>/dev/null || true; }

spec_pct() { # $1 = dir
  if [[ -f "$1/.implemented" ]]; then echo 100; return; fi
  # All tasks ticked still leaves converge, the gate and the commit: 100% means built.
  local t k p; t=$(total "$1"); k=$(ticked "$1")
  if (( ${t:-0} > 0 )); then p=$(( 100 * k / t )); (( p > 95 )) && p=95; echo "$p"; else echo 0; fi
}

overall_pct() {
  local sum=0 n=0 id dir
  while IFS=$'\t' read -r id dir; do sum=$(( sum + $(spec_pct "$dir") )); n=$(( n + 1 )); done < "$SCOPE"
  (( n > 0 )) && echo $(( sum / n )) || echo 100
}

current_spec() { # first spec in scope that is not built yet: "id<tab>dir"
  local id dir
  while IFS=$'\t' read -r id dir; do [[ -f "$dir/.implemented" ]] || { printf '%s\t%s\n' "$id" "$dir"; return; }; done < "$SCOPE"
}

first_open_task() { grep -m1 -E '^- \[ \]' "$1/tasks.md" 2>/dev/null | grep -o -E '\bT[0-9]+\b' | head -1; }

describe() { # one line for --status
  local cur id dir
  cur="$(current_spec)"
  if [[ -z "$cur" ]]; then echo "all $(wc -l < "$SCOPE") spec(s) in scope are built"; return; fi
  IFS=$'\t' read -r id dir <<<"$cur"
  echo "overall $(overall_pct)%  |  now $id: $(ticked "$dir")/$(total "$dir") tasks, next open ${1:-$(first_open_task "$dir")}"
}

# ---- raise / clear: each warning notifies once when it starts and once, quietly, when it ends ----
raise() { # key title message
  local f="$STATE/flags/$1"
  [[ -f "$f" ]] && return 0
  now > "$f"
  say "RAISED  $1: $3"
  notify warn "$2" "$3"
}
clear_flag() { # key title message
  local f="$STATE/flags/$1"
  [[ -f "$f" ]] || return 0
  local since; since=$(cat "$f"); rm -f "$f"
  say "CLEARED $1 after $(hm "$(mins "$since")"): $3"
  notify info "$2" "$3 (it lasted $(hm "$(mins "$since")"))"
}
flag_on() { [[ -f "$STATE/flags/$1" ]]; }

milestones() { # $1 = overall percent
  local m
  for m in 25 50 75 100; do
    if (( $1 >= m )) && [[ ! -f "$STATE/flags/milestone$m" ]]; then
      touch "$STATE/flags/milestone$m"
      say "MILESTONE $m%  $(describe)"
      notify info "SDD run: ${m}%" "$(describe)  (elapsed $(hm "$(mins "$(cat "$STATE/started")")"))"
    fi
  done
}

active_recently() { # any source, spec or script file touched within STALL_MIN minutes
  [[ -n "$(find packages specs scripts docs -type f -mmin "-$STALL_MIN" \
      -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' -not -path '*/coverage/*' \
      -not -name '*.log' -print -quit 2>/dev/null)" ]]
}

loop_alive() { pgrep -f "[i]mplement-specs.sh" >/dev/null; }

check_once() {
  local pct cur id dir task tick_total=0 d
  pct="$(overall_pct)"; milestones "$pct"
  cur="$(current_spec)"

  # task completions: a quiet line per tick, no notification
  while IFS=$'\t' read -r id d; do tick_total=$(( tick_total + $(ticked "$d") )); done < "$SCOPE"
  local last_ticks; last_ticks=$(cat "$STATE/ticks" 2>/dev/null || echo "$tick_total")
  if (( tick_total != last_ticks )); then
    say "progress  ${tick_total} tasks ticked in scope (was ${last_ticks})  $(describe)"
    echo "$tick_total" > "$STATE/ticks"; now > "$STATE/last_progress"
  else
    echo "$tick_total" > "$STATE/ticks"
  fi
  [[ -f "$STATE/last_progress" ]] || now > "$STATE/last_progress"

  # one task open too long, and its finish
  if [[ -n "$cur" ]]; then
    IFS=$'\t' read -r id dir <<<"$cur"
    task="$(first_open_task "$dir")"
    if [[ -z "$task" ]]; then
      # every task is ticked: converge, the gate and the commit follow; a long task, if any, is over
      clear_flag long_task "SDD: long task finished" "$id has no open task left"
      echo "$id/" > "$STATE/task"; now > "$STATE/task_since"
    elif [[ "$(cat "$STATE/task" 2>/dev/null)" != "$id/$task" ]]; then
      local prev; prev="$(cat "$STATE/task" 2>/dev/null)"
      if flag_on long_task; then clear_flag long_task "SDD: long task finished" "${prev:-previous task} is done"; fi
      echo "$id/$task" > "$STATE/task"; now > "$STATE/task_since"
    elif (( $(mins "$(cat "$STATE/task_since")") >= TASK_WARN_MIN )); then
      raise long_task "SDD: task running long" "$id $task has been the first open task for $(hm "$(mins "$(cat "$STATE/task_since")")")"
    fi
  fi

  # stalled: no tick and no file change for STALL_MIN
  if [[ -n "$cur" ]] && ! active_recently && (( $(mins "$(cat "$STATE/last_progress")") >= STALL_MIN )); then
    raise stalled "SDD: run looks stalled" "No file change and no finished task for $STALL_MIN+ minutes at $(describe)"
  else
    clear_flag stalled "SDD: run recovered" "Work resumed at $(describe)"
  fi

  # the loop itself
  if [[ -n "$cur" ]] && ! loop_alive; then
    raise loop_gone "SDD: loop is not running" "implement-specs.sh is gone at $(describe). If it ended on its own you also got its own notification."
  else
    clear_flag loop_gone "SDD: loop is running again" "implement-specs.sh is back"
  fi

  # the machine
  local used; used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
  if (( used >= DISK_WARN_PCT )); then raise disk "SDD: disk almost full" "Root disk at ${used}%"
  else clear_flag disk "SDD: disk ok" "Root disk back to ${used}%"; fi
  local dead; dead=$(docker ps -a --filter status=exited --filter name=marketplace_test --format '{{.Names}}' 2>/dev/null | grep -v minio_init | tr '\n' ' ')
  if [[ -n "$dead" ]]; then raise containers "SDD: test container exited" "Exited: $dead"
  else clear_flag containers "SDD: test stack ok" "Containers are up again"; fi

  [[ -n "${HEARTBEAT_URL:-}" ]] && curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1
  return 0
}

main() {
  local status_only=""
  [[ "${1:-}" == "--status" ]] && { status_only=1; shift; }
  if [[ ! -s "$SCOPE" || -n "${MONITOR_RESET:-}" ]]; then build_scope "$@"; now > "$STATE/started"; rm -f "$STATE"/flags/* "$STATE/ticks" "$STATE/task" "$STATE/last_progress" "$STATE/baselined"; fi
  [[ -f "$STATE/started" ]] || now > "$STATE/started"
  # Milestones already behind us at the first start are baseline, not news.
  if [[ -z "$status_only" && ! -f "$STATE/baselined" ]]; then
    local base m; base="$(overall_pct)"
    for m in 25 50 75 100; do (( base >= m )) && touch "$STATE/flags/milestone$m"; done
    touch "$STATE/baselined"
  fi
  if [[ -n "$status_only" ]]; then
    echo "scope: $(cut -f1 "$SCOPE" | tr '\n' ' ')"; describe; return 0
  fi
  say "monitor started: scope $(cut -f1 "$SCOPE" | tr '\n' ' ')| every ${INTERVAL}s, stall ${STALL_MIN}m, task ${TASK_WARN_MIN}m"
  notify info "SDD monitor started" "$(describe)"
  while :; do
    check_once
    if [[ -z "$(current_spec)" ]]; then say "all specs in scope are built; monitor exiting"; break; fi
    sleep "$INTERVAL"
  done
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] && main "$@"
