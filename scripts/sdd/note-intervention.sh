#!/usr/bin/env bash
# note-intervention.sh "text" [capability]: tag something a person had to do or find by hand, so the report can count it
# (docs/work/architecture/sdd-runbook.md, "Metrics"). Appends one line to .sdd-metrics/steps.jsonl.
#   scripts/sdd/note-intervention.sh "found by hand: payment stays PENDING (queue missing)" S48
#   scripts/sdd/note-intervention.sh "restarted the stack by hand"
# Convention: start the text with "found by hand:" for a defect no automated check found; scripts/sdd/report.py counts those separately.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
source "$ROOT/scripts/sdd/lib.sh"
text="${1:?usage: note-intervention.sh \"text\" [capability]}"
now=$(date +%s)
metric_step "${2:--}" intervention "$now" "$now" noted 1 "$text"
echo "noted in ${SDD_METRICS_DIR}/steps.jsonl"
