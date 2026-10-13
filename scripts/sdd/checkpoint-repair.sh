#!/usr/bin/env bash
# Repair path for a failed checkpoint, and the flake signal for gates and checkpoints (runbook, "Follow-ups for the build loop" 1 and 2).
# Sourced by implement-specs.sh, which provides step(); run directly it only has a dry run:
#
#   scripts/sdd/checkpoint-repair.sh --dry-run <label> [--log FILE] [--results-dir DIR]
#       prints what the loop would do for that checkpoint (failures read from its log, the attempts, the repair prompt); runs and writes nothing
#
# In the loop (implement-specs.sh): checkpoint_with_repair <label> runs scripts/sdd/checkpoint.sh; when it fails, a repair agent with a fresh
# context gets the failing tests, the page snapshots and the log, then the checkpoint runs again, at most MAX_CHECKPOINT_REPAIRS times
# (default MAX_GATE_REPAIRS, 5), inside the shared REPAIR_BUDGET_MIN. A failure that goes away while the code is unchanged is a flake: it is
# recorded (gaps.md for a gate, specs/.checkpoints/<label>.flakes.md for a checkpoint), listed in the final notification, and flagged in the metrics.
_CR_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
ROOT="${ROOT:-$_CR_ROOT}"
declare -F run_claude >/dev/null || source "$ROOT/scripts/sdd/lib.sh"
FAILURES_PY="$ROOT/scripts/sdd/failures.py"
PW_RESULTS_DIR="${PW_RESULTS_DIR:-$ROOT/packages/web/test-results}"

ckpt_max() { echo "${MAX_CHECKPOINT_REPAIRS:-${MAX_GATE_REPAIRS:-5}}"; }

# checkpoint_repair_prompt <label> <log> <attempt> <max>
checkpoint_repair_prompt() {
  local lessons="${LESSONS:-}"
  printf '%s\n%s\n%s' "You are the repair agent of an unattended build loop. The regression checkpoint '$1' FAILED (repair attempt $3 of $4) and the loop cannot continue until it passes. The checkpoint (scripts/sdd/checkpoint.sh) runs every backend e2e suite in batches, the web Playwright suite when the dev stack is up, the living-specification checks, and scripts/sdd/checkpoints/$1.sh (a scripted walk of the flow) if it exists. Below: what failed, the page snapshots Playwright saved, and the end of the log (full log: $2). How to work: (1) For each failure decide whether the ENVIRONMENT or the CODE is at fault: many tests failing the same way at a timeout, a 503/5xx from an endpoint they only wait on, a missing browser, a container that is down or a stale search index are environment faults: run 'bash scripts/sdd/stack-fix.sh smoke' and the action it names, read the API log (/var/log/sdd/api.log on the runner), do not edit tests or pages around a broken environment. (2) A regression means something built later broke something built earlier: find what shared code changed (git log is allowed), read the failing test and the page snapshot, and fix the root cause in the code. A failing suite in a domain with no built capability is not counted and not yours. (3) A failing test in packages/web/tests/qa/ was written from a defect that the QA agent found and a skeptical second session reproduced: the PRODUCT is wrong, so fix the product until it passes; if the test itself is plainly wrong, say needs human. Never skip, weaken or delete a test; never create or edit a *.reviewed.json; change nothing unrelated. (4) Re-run only the narrowest failing check yourself (scripts/sdd/test-spec.sh <path>, npx playwright test <file> --reporter=line, npx tsc --noEmit); do NOT run the whole checkpoint, the loop does that next (it takes up to an hour). (5) If a failing test passes when you re-run it and you changed nothing, it is a flake: change no code and say so. (6) From attempt 2 on, append a draft lesson to docs/lessons.md (an index line '- L-nnn <date> <class> open' and an entry with Rule, Symptom, Cause and 'Prevention missing:'); python3 scripts/lessons/check.py must still pass. End your final message with exactly one line: 'CHECKPOINT-REPAIR: fixed' if the checkpoint can run again, 'CHECKPOINT-REPAIR: flake' if the failure did not reproduce and you changed nothing, or 'CHECKPOINT-REPAIR: needs human: <one sentence why>'." "$lessons" "$(python3 "$FAILURES_PY" digest "$2" --label "$1" --results-dir "$PW_RESULTS_DIR")"
}

# flake_record <what> <first failing log> <file to append the note to>
flake_record() {
  python3 "$FAILURES_PY" flake-note "$2" --label "$1" --append "$3" 2>/dev/null || true
  local n; n="$(python3 "$FAILURES_PY" names "$2" 2>/dev/null | head -3 | tr '\n' ';')"
  [[ -n "${STATE_FILE:-}" ]] && printf '%s: %s\n' "$1" "${n:-?}" >> "$STATE_FILE.flakes"
  notify info "SDD: $1 passed after a repair that changed no code" "A flake, not a fix: ${n:-see the log}. Recorded in $3." || true
}

# step_metric <dir> <step> <t0> <rc> <try> <code fingerprint before, if this is a repair step>: the metrics line of a finished claude step
step_metric() {
  local cap="${METRIC_CAP:-$(basename "$1" | cut -d- -f1)}" out extra=""
  out="$(step_outcome "$4" "$1/.$2.log")"
  if [[ -n "${6:-}" ]]; then extra="\"code_changed\":$([[ "$(code_fingerprint)" != "$6" ]] && echo true || echo false)"; fi
  metric_step "$cap" "$2" "$3" "$(date +%s)" "${out%% *}" "$5" "${out#* }" "$extra"
}

# The gate loop calls these: gate_failed <id> <dir> <t0> <attempt>, gate_passed <id> <dir> <t0> <attempt>. GATE_FP is the code fingerprint at the first failure.
gate_reason() { grep -m1 -E '^(FAIL |.*error TS[0-9]+|scenarios in test-plan|.*integrity|check:|direct \.transaction|tsc failed)' "$1" 2>/dev/null | cut -c1-200 || true; }
gate_failed() {
  metric_step "$1" gate "$3" "$(date +%s)" fail "$4" "$(gate_reason "$2/.gate.log")"
  if [[ -z "${GATE_FP:-}" ]]; then GATE_FP="$(code_fingerprint)"; cp "$2/.gate.log" "$2/.gate.first-fail.log" 2>/dev/null || true; fi
}
gate_passed() {
  local extra=""
  if [[ -n "${GATE_FP:-}" && "$(code_fingerprint)" == "$GATE_FP" ]]; then
    extra='"flake":true'; flake_record "$1 gate" "$2/.gate.first-fail.log" "$2/gaps.md"
  fi
  metric_step "$1" gate "$3" "$(date +%s)" pass "$4" "" "$extra"
}

# checkpoint_with_repair <label>: 0 when the checkpoint passes (possibly after repairs), 1 when it stays failed.
checkpoint_with_repair() {
  local label="$1" log="$ROOT/specs/.checkpoints/$1.log" first="$ROOT/specs/.checkpoints/$1.first-fail.log"
  local attempt=0 max t0 fp="" extra budget_left cap t1 drc
  max="$(ckpt_max)"
  while :; do
    t0=$(date +%s)
    if "$ROOT/scripts/sdd/checkpoint.sh" "$label"; then
      extra=""
      if (( attempt > 0 )) && [[ "$(code_fingerprint)" == "$fp" ]]; then
        extra='"flake":true'; flake_record "checkpoint $label" "$first" "$ROOT/specs/.checkpoints/$label.flakes.md"
      fi
      metric_step "checkpoint:$label" checkpoint "$t0" "$(date +%s)" pass "$((attempt + 1))" "" "$extra"
      return 0
    fi
    attempt=$((attempt + 1))
    metric_step "checkpoint:$label" checkpoint "$t0" "$(date +%s)" fail "$attempt" "$(python3 "$FAILURES_PY" names "$log" 2>/dev/null | head -1)"
    if (( attempt == 1 )); then fp="$(code_fingerprint)"; cp "$log" "$first" 2>/dev/null || true; fi
    if (( attempt > max )); then return 1; fi
    budget_left=$(( ${REPAIR_BUDGET_MIN:-60} * 60 - ${REPAIR_USED:-0} ))
    if (( budget_left < 120 )); then echo "  checkpoint $label failed and the repair budget is used up"; return 1; fi
    cap=$(( budget_left < 1500 ? budget_left : 1500 )); t1=$SECONDS
    echo "  checkpoint $label failed: repair agent (attempt $attempt of $max, repair budget left $((budget_left / 60)) min)"
    notify info "SDD: checkpoint $label failed, repair in progress" "The repair agent is working on the failing tests (attempt $attempt of $max). You get another message if it needs you."
    ( export PASS_TIMEOUT_S=$cap; METRIC_CAP="checkpoint:$label"; step "$ROOT/specs/.checkpoints" "ckrepair-$label-$attempt" "$(checkpoint_repair_prompt "$label" "$log" "$attempt" "$max")" ) && drc=0 || drc=$?
    REPAIR_USED=$(( ${REPAIR_USED:-0} + SECONDS - t1 ))
    case $drc in 75|76|77) exit "$drc" ;; esac
    if (( drc != 0 )); then echo "  the checkpoint repair step failed (see specs/.checkpoints/.ckrepair-$label-$attempt.log)"; return 1; fi
    if grep -q 'CHECKPOINT-REPAIR: needs human' "$ROOT/specs/.checkpoints/.ckrepair-$label-$attempt.log" 2>/dev/null; then
      echo "  $(grep -o 'CHECKPOINT-REPAIR: needs human:.*' "$ROOT/specs/.checkpoints/.ckrepair-$label-$attempt.log" | head -1 | cut -c1-300)"; return 1
    fi
  done
}

dry_run() { # <label> [--log FILE] [--results-dir DIR]
  local label="${1:?usage: checkpoint-repair.sh --dry-run <label> [--log FILE] [--results-dir DIR]}"; shift
  local log="$ROOT/specs/.checkpoints/$label.log" max; max="$(ckpt_max)"
  while (( $# )); do case "$1" in --log) log="$2"; shift 2 ;; --results-dir) PW_RESULTS_DIR="$2"; shift 2 ;; *) echo "unknown argument: $1" >&2; return 2 ;; esac; done
  echo "DRY RUN for checkpoint '$label': nothing is executed or written."
  echo "1. Run: scripts/sdd/checkpoint.sh $label   (its log: specs/.checkpoints/$label.log)"
  echo "2. If it fails: up to $max repair attempts (MAX_CHECKPOINT_REPAIRS, default MAX_GATE_REPAIRS), each one a fresh-context repair agent for at most"
  echo "   $(( ${REPAIR_BUDGET_MIN:-60} < 25 ? ${REPAIR_BUDGET_MIN:-60} : 25 )) minutes, drawn from the shared repair budget of ${REPAIR_BUDGET_MIN:-60} minutes (REPAIR_BUDGET_MIN)."
  echo "3. After each attempt the checkpoint runs again. If it passes while the code (packages, scripts) is byte-identical to what it was at the first failure,"
  echo "   it was a flake: the failing tests go to specs/.checkpoints/$label.flakes.md and into the final notification, and the metrics line carries \"flake\":true."
  echo "4. If the attempts or the budget are used up, or the agent answers 'CHECKPOINT-REPAIR: needs human: ...', the run stops with 'Checkpoint $label FAILED'."
  echo "5. Metrics (not written now): $SDD_METRICS_DIR/steps.jsonl gets 'checkpoint' (pass/fail, attempt) and 'ckrepair-$label-N' (code_changed) lines."
  echo
  if [[ -f "$log" ]]; then
    echo "Failures read from $log:"
    python3 "$FAILURES_PY" names "$log" | head -20 | sed 's/^/  - /'
    echo
  else
    echo "No log at $log yet; the prompt below is built from an empty log."; log=/dev/null; echo
  fi
  echo "===== the prompt repair attempt 1 would get ====="
  LESSONS="${LESSONS:-$(lessons_block)}" checkpoint_repair_prompt "$label" "$log" 1 "$max"; echo
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  case "${1:-}" in
    --dry-run) shift; dry_run "$@" ;;
    *) echo "usage: scripts/sdd/checkpoint-repair.sh --dry-run <label> [--log FILE] [--results-dir DIR]   (the repair itself runs inside implement-specs.sh)" >&2; exit 2 ;;
  esac
fi
