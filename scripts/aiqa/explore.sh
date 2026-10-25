#!/usr/bin/env bash
# Runs tester passes for one area until its map has no untested line, or MAX_PASSES is reached.
# Usage: scripts/aiqa/explore.sh <area> [lines-per-pass=25] [minutes-per-pass=25] [max-passes=12]
set -u
AREA="${1:?area name, e.g. inventory}"; LINES="${2:-25}"; MIN="${3:-25}"; MAX="${4:-12}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
MAP="scripts/aiqa/coverage/$AREA.tsv"; [[ -f "$MAP" ]] || { echo "no map $MAP"; exit 2; }
open() { awk -F'\t' 'NR>1 && $6=="untested"' "$MAP" | wc -l; }
for pass in $(seq 1 "$MAX"); do
  n="$(open)"; echo "[$(date +%T)] $AREA pass $pass: $n untested lines"
  [[ "$n" -eq 0 ]] && break
  prompt="$(sed -e "s/{{AREA}}/$AREA/g" -e "s/{{MINUTES}}/$MIN/g" -e "s/{{LINES}}/$LINES/g" scripts/aiqa/prompts/tester.md)"
  timeout "$(( (MIN + 10) * 60 ))" claude -p "$prompt" --permission-mode bypassPermissions > "/tmp/fe/aiqa-$AREA-pass$pass.log" 2>&1
  echo "[$(date +%T)] pass $pass ended (exit $?)"; node scripts/aiqa/status.mjs "$AREA" | tail -1
done
node scripts/aiqa/status.mjs "$AREA" | head -1
