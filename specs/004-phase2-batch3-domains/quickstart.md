# Quickstart: Verify Phase 2 Batch 3

Run everything from `packages/backend`. Nothing here starts a server or a database.

```bash
# 1. Layout
ls libs/domains                      # 16 domains
ls libs/common/src/models            # all-models.ts only
ls libs/common/src | grep -xE 'billing|statements|auctions|launch-events|live|shop-functions|assets|media|video|catalog-import|integrations|offline-sync'   # expect: nothing
ls libs/domains/payments | grep bis-utils   # bis-utils.module.ts (moved from orders, R2)

# 2. Types, unit tests, registry
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # exit 0
npx jest --ci        # 30/31 suites, 130 tests; only discussions/ranking.spec.ts fails (pre-existing)
npx jest --ci db/    # 5 passed; placement covers 28 domain + 2 infra models

# 3. Boundaries
grep -rnE "['\"]@app/domains/[a-z0-9-]+/" --include=*.ts apps libs test   # no output (X.4)
grep -n "@app/domains/catalog-sync" libs/domains/orders -r                 # no output (R3)

# 4. Runtime module graph
pnpm check:module-graph   # ✓ ×9 (core 315, worker 227, payment-processor 34, local-monolith 509)

# 5. Builds and e2e discovery
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # 52

# 6. Re-apply guard
bash scripts/refactor/phase2-move.sh scripts/refactor/phase2-batch3-moves.tsv --dry-run   # "Batch already applied", exit 1
```
