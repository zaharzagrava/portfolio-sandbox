# Quickstart: Verify Phase 2 Batch 5

Run everything from `packages/backend`. None of these commands start a server or a database.

```bash
# 1. Layout
ls libs/domains | wc -l      # expect 25
find libs/common/src -type f | grep -vE "^libs/common/src/(models/all-models\.ts|types\.ts|index\.ts|seeds/|utils/test-utils/|bff/batch-read\.controller\.ts)"   # expect no output
ls libs/common/core/murmur3.ts   # expect the file (D-13)
grep -rn "flags/murmur3" --include=*.ts libs apps   # expect no output

# 2. Types, unit tests, registry
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # expect exit 0
npx jest --ci        # expect 30/31 suites, 130 tests; the only failure is community/domain/ranking.spec.ts (marked ESM, pre-existing)
npx jest --ci db/    # expect 5 passed

# 3. Boundaries
grep -rnE "['\"]@app/domains/[a-z0-9-]+/" --include=*.ts apps libs test   # expect no output
pnpm check:module-graph      # expect ✓ ×9 with unchanged node counts
pnpm check:table-ownership   # report: expect 87 cross-domain data accesses in 21 domains (debt D-7/D-12)

# 4. Builds and e2e discovery
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # expect 52

# 5. Re-apply guard
bash scripts/refactor/phase2-move.sh scripts/refactor/phase2-batch5-moves.tsv --dry-run   # expect "Batch already applied", exit 1
```
