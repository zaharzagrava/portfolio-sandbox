#!/usr/bin/env bash
# Phase 2: legacy folders → libs/domains/<d>/{api,application,domain,infra}, one batch per move map
# (constitution I.1, X.2; docs/architecture/domain-map.md §1.1).
#
#   bash scripts/refactor/phase2-move.sh <batch-moves.tsv>            # rewrite imports, then git mv
#   bash scripts/refactor/phase2-move.sh <batch-moves.tsv> --dry-run  # report only
#
# The map's `# batch-dirs:` line lists the legacy folders the batch must empty completely.
# Step 2 (single entry point per domain, X.4) is scripts/refactor/phase2-entrypoints.ts.
set -euo pipefail

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOVES="$(realpath "${1:?usage: phase2-move.sh <batch-moves.tsv> [--dry-run]}")"
LEGACY="$BACKEND/libs/common/src"
read -r -a BATCH_DIRS <<<"$(sed -n 's/^# batch-dirs: *//p' "$MOVES")"
DRY="${2:-}"

cd "$BACKEND"
entries() { grep -v '^#' "$MOVES" | awk -F'\t' 'NF==2'; }
while read -r dst; do
  if [[ -e "libs/$dst" ]]; then
    echo "Batch already applied: libs/$dst exists ($(basename "$MOVES"))." >&2
    exit 1
  fi
done < <(entries | cut -f2)

# 1. Every mapped source exists, and every file in the batch folders is covered by an entry.
entries | while IFS=$'\t' read -r src dst; do
  [[ -e "$LEGACY/$src" ]] || { echo "Missing source: libs/common/src/$src" >&2; exit 1; }
done
uncovered=0
for dir in "${BATCH_DIRS[@]}"; do
  while read -r file; do
    rel="${file#"$LEGACY/"}"
    if ! entries | cut -f1 | awk -v f="$rel" '$0 == f || index(f, $0 "/") == 1 { hit = 1 } END { exit !hit }'; then
      echo "Not in move map: libs/common/src/$rel" >&2; uncovered=1
    fi
  done < <(find "$LEGACY/$dir" -type f)
done
(( uncovered == 0 )) || exit 1

# 2. Rewrite imports against the current layout.
python3 "$BACKEND/scripts/refactor/rewrite_imports.py" "$BACKEND" "$MOVES" ${DRY:+"$DRY"}
[[ "$DRY" == "--dry-run" ]] && exit 0

# 3. Move. Destinations are disjoint, so order doesn't matter.
entries | while IFS=$'\t' read -r src dst; do
  mkdir -p "$(dirname "libs/$dst")"
  git mv "$LEGACY/$src" "libs/$dst"
done

# 4. The batch folders must now be empty; remove them.
for dir in "${BATCH_DIRS[@]}"; do
  if [[ -n "$(find "$LEGACY/$dir" -type f 2>/dev/null)" ]]; then
    echo "Leftover files in libs/common/src/$dir" >&2; exit 1
  fi
  rm -rf "${LEGACY:?}/$dir"
done

echo "Batch moves done ($(basename "$MOVES")):"
find libs/domains -maxdepth 2 -type d | sort
