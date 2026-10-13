#!/usr/bin/env bash
# Earns trust in the QA agent: puts back, one at a time, defects that really happened, runs the agent on the buy charter, and checks that it reports each.
# Then one clean run: it must report at most 2 findings, each real or SUSPICIOUS. Needs the stack and web server up; edits (and restores) tracked files.
#   scripts/qa/benchmark.sh [mutation...]      mutations: scripts/qa/mutations/*.sh (default: all)    result: scripts/qa/benchmark-<date>.md
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
[[ -z "$(git status --porcelain packages/backend)" ]] || { echo "packages/backend has uncommitted changes: commit or stash them first (a mutation restores files with git checkout)" >&2; exit 2; }
MUT=("$@"); [[ ${#MUT[@]} -gt 0 ]] || MUT=($(cd scripts/qa/mutations && ls *.sh | sed 's/\.sh$//'))
OUT="scripts/qa/benchmark-$(date +%Y-%m-%d-%H%M).md"; TMP="$(mktemp -d)"
echo "# QA agent benchmark $(date -u +%FT%TZ)" > "$OUT"; hits=0; total=0
for m in "${MUT[@]}"; do
  ( source "scripts/qa/mutations/$m.sh"; trap revert EXIT; apply; scripts/qa/run.sh buy --minutes 10 --out "$TMP/$m" >/dev/null 2>&1; r="$(cat "$TMP/$m"/*-buy.md 2>/dev/null)"
    if grep '^DEFECT .* CONFIRMED' <<<"$r" | grep -qiE "$EXPECT"; then echo "- $m: FOUND ($(grep -c '^DEFECT' <<<"$r") defect(s) in the report)"; else echo "- $m: MISSED (report: $TMP/$m)"; fi ) >> "$OUT"
  total=$((total+1)); tail -1 "$OUT" | grep -q FOUND && hits=$((hits+1))
  git checkout -q packages/backend 2>/dev/null
  # a mutation leaves its damage behind (parked and stale outbox rows, queued messages): clear it, or the next run reports leftovers instead of its own defect
  docker exec -i "$(docker ps --format '{{.Names}}' | grep -m1 payment_system_db)" psql -U postgres -d marketplace -qAt -c "delete from \"Outbox\" where status <> 'published'" >/dev/null 2>&1
done
scripts/infra/doctor-live.sh --quiet || echo "- note: the stack is not healthy after the mutations; check scripts/infra/doctor-live.sh" >> "$OUT"
scripts/qa/run.sh buy --minutes 10 --out "$TMP/clean" >/dev/null 2>&1; c="$(cat "$TMP/clean"/*-buy.md 2>/dev/null)"
echo "- clean build: $(grep -c '^DEFECT .* CONFIRMED' <<<"$c") confirmed, $(grep -c '^DEFECT .* SUSPICIOUS' <<<"$c") suspicious (report: $TMP/clean)" >> "$OUT"
echo "- result: $hits of $total seeded defects found" >> "$OUT"; cat "$OUT"
