#!/usr/bin/env bash
# Backend mutation run on the money / stock / permission / pagination files used by the four AI QA areas (entry, inventory, media, orders).
# Uses the in-house scripts/mutation/mutate.py (jest unit specs; no docker and no services needed, but a free CPU: one jest run per mutant).
#   scripts/aiqa/tracks/mutation/backend.sh [--max N] [--min-score 0.6]     N mutants per file (default 25)
# Prints survivors per file and a final table; exit 1 if a file is below the minimum score.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
MAX=25; MIN=0.6
while [[ $# -gt 0 ]]; do case "$1" in --max) MAX="$2"; shift 2;; --min-score) MIN="$2"; shift 2;; *) echo "unknown $1" >&2; exit 2;; esac; done
D=packages/backend/libs/domains
FILES=(
  # permissions (who may do what)
  $D/tenancy/domain/permissions.ts $D/tenancy/domain/role-policy.ts $D/tenancy/domain/shop-status.ts
  # stock (inventory) and money (orders)
  $D/catalog/domain/stock-rule.ts $D/catalog/domain/product-input.ts $D/catalog/domain/product-status.ts
  $D/orders/domain/money-allocation.ts $D/orders/domain/stock-operations.ts $D/orders/domain/order-state.ts
  $D/fulfilment/domain/stock-rules.ts
  # paging (cursors)
  $D/tenancy/domain/cursor.ts $D/fulfilment/domain/search-cursor.ts
)
# no unit spec next to these yet (mutate.py needs one, so they are skipped; write a spec to include them):
#   catalog/domain/product-cursor.ts, catalog/domain/stock-input.ts, orders/domain/order-cursor.ts
OUT="$ROOT/scripts/aiqa/tracks/mutation/backend-$(date +%F).txt"; : > "$OUT"; rc=0
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "missing $f" | tee -a "$OUT"; continue; }
  python3 scripts/mutation/mutate.py "$f" --max "$MAX" --min-score "$MIN" 2>&1 | tee -a "$OUT" || rc=1
done
echo "full output: $OUT"; exit $rc
