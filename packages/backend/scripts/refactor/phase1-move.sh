#!/usr/bin/env bash
# Phase 1 refactor: libs/common/src → libs/{infrastructure,common,composition} (constitution X).
# Idempotent guard: refuses to run twice. Business domains stay in libs/common/src until Phase 2.
#
#   bash scripts/refactor/phase1-move.sh            # rewrite imports, then git mv
#   bash scripts/refactor/phase1-move.sh --dry-run  # report only
set -euo pipefail

BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOVES="$BACKEND/scripts/refactor/phase1-moves.tsv"
LEGACY="$BACKEND/libs/common/src"
DRY="${1:-}"

cd "$BACKEND"
if [[ -d libs/infrastructure/redis ]]; then
  echo "Phase 1 already applied (libs/infrastructure/redis exists)." >&2
  exit 1
fi
if [[ "$DRY" != "--dry-run" ]] && ! git diff --quiet -- . ; then
  echo "Uncommitted changes under packages/backend; commit or stash first." >&2
  exit 1
fi

# 1. Every source in the map must exist before anything changes.
while IFS=$'\t' read -r src dst; do
  [[ -z "$src" || "$src" == \#* ]] && continue
  [[ -e "$LEGACY/$src" ]] || { echo "Missing source: libs/common/src/$src" >&2; exit 1; }
done < "$MOVES"

# 2. Rewrite imports against the old layout.
python3 "$BACKEND/scripts/refactor/phase1_rewrite_imports.py" "$BACKEND" "$MOVES" ${DRY:+"$DRY"}
[[ "$DRY" == "--dry-run" ]] && exit 0

# 3. Create the area roots and move (git mv keeps history). Single files first, so a directory
#    move never drags a file that the map sends elsewhere.
mkdir -p libs/infrastructure libs/common libs/composition
move() {
  local src="$1" dst="$2"
  [[ "$src" == "$dst" ]] && return 0
  mkdir -p "$(dirname "$dst")"
  git mv "$src" "$dst"
}
STASH="$BACKEND/libs/.phase1-keep"
entries() { grep -v '^#' "$MOVES" | awk -F'\t' 'NF==2'; }

# 3a. Park files that stay behind while their parent directory moves (bff/batch-read.controller.ts).
entries | while IFS=$'\t' read -r src dst; do
  [[ "$dst" == common/src/* ]] || continue
  mkdir -p "$STASH"; git mv "$LEGACY/$src" "$STASH/$(basename "$src")"
done

# 3b. Directories, shallowest destination first, so libs/infrastructure/database exists before
#     utils/db-utils lands inside it.
entries | while IFS=$'\t' read -r src dst; do
  if [[ -d "$LEGACY/$src" ]]; then
    printf '%s\t%s\t%s\n' "$(tr -cd '/' <<<"$dst" | wc -c)" "$src" "$dst"
  fi
done | sort -n | cut -f2- | while IFS=$'\t' read -r src dst; do
  move "$LEGACY/$src" "libs/$dst"
done

# 3c. Single files, after their destination directories exist (models/outbox.model.ts → outbox/).
entries | while IFS=$'\t' read -r src dst; do
  if [[ -f "$LEGACY/$src" && "$dst" != common/src/* ]]; then
    move "$LEGACY/$src" "libs/$dst"
  fi
done

# 3d. Restore parked files.
entries | while IFS=$'\t' read -r src dst; do
  [[ "$dst" == common/src/* ]] || continue
  mkdir -p "$(dirname "libs/$dst")"; git mv "$STASH/$(basename "$src")" "libs/$dst"
done
rmdir "$STASH" 2>/dev/null || true

echo "Phase 1 moves done:"
ls libs/infrastructure libs/composition
ls -d libs/common/*/
