#!/usr/bin/env bash
# ckpt-progress.sh: progress lines and phone messages for a CHECKPOINT (checkpoint.sh, checkpoints/<label>.sh). Never sourced by the per-capability gates.
#   ckpt_init <label>           sets the label and the start time (exported, so the flow scripts share them)
#   ckpt_note <kind> <text>     one line "[checkpoint <label> +12m] <text>" on stdout and the same text as a message (kind: info | ok | warn | fail)
#   ckpt_bucket <done> <total> <step>   the highest multiple of <step> percent reached (10 for 123 of 593 -> 20)
#   ckpt_progress <what> <done> <total> <step> <extra>   a note when a new <step> percent boundary (below 100) is crossed; remembers the last one
#   ckpt_watch_playwright <log> <what> <step>   background poller for a Playwright run (list reporter): notes at every <step> percent, until killed
# CKPT_NOTIFY=0 turns the messages off (the lines stay).
_ckpt_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F notify >/dev/null; then ROOT="${ROOT:-$(git -C "$_ckpt_dir" rev-parse --show-toplevel)}"; source "$_ckpt_dir/lib.sh" 2>/dev/null || notify() { :; }; fi

ckpt_init() { export CKPT_LABEL="$1" CKPT_START_EPOCH="${CKPT_START_EPOCH:-$(date +%s)}"; }

ckpt_note() {
  local kind="$1"; shift; local text="$*" mins=$(( ($(date +%s) - ${CKPT_START_EPOCH:-$(date +%s)}) / 60 ))
  echo "  [checkpoint ${CKPT_LABEL:-?} +${mins}m] $text"
  [[ "${CKPT_NOTIFY:-1}" == 0 ]] || notify "$kind" "SDD checkpoint ${CKPT_LABEL:-?}" "$text (+${mins} min)" || true
}

ckpt_bucket() { local done=$1 total=$2 step=$3; (( total > 0 && step > 0 )) || { echo 0; return; }; echo $(( done * 100 / total / step * step )); }

declare -A _CKPT_LAST=()   # last reported bucket per <what>
ckpt_progress() {
  local what="$1" done=$2 total=$3 step=$4 extra="${5:-}" b key="${1// /_}"
  b=$(ckpt_bucket "$done" "$total" "$step")
  if (( b > ${_CKPT_LAST[$key]:-0} && b < 100 )); then
    _CKPT_LAST[$key]=$b
    ckpt_note info "$what ${b}% ($done of $total)${extra:+, $extra}"
  fi
}

ckpt_watch_playwright() {
  local log="$1" what="$2" step="${3:-25}" total="" done failed
  while sleep 30; do
    [[ -n "$total" ]] || total="$(grep -aoE 'Running [0-9]+ tests?' "$log" 2>/dev/null | tail -1 | grep -oE '[0-9]+')"
    [[ -n "$total" ]] || continue
    done="$(grep -acE '^\s+[✓✘-]\s+[0-9]+ ' "$log" 2>/dev/null)"; failed="$(grep -acE '^\s+✘\s+[0-9]+ ' "$log" 2>/dev/null)"
    ckpt_progress "$what" "${done:-0}" "$total" "$step" "$failed failing so far"
  done
}
