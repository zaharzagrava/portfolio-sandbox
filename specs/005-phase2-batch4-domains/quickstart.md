# Quickstart: Verify Phase 2 Batch 4

All commands run from `packages/backend`. None of them start a server or a database.

```bash
# 1. Layout
ls libs/domains   # 21 domains: … community content discovery notifications seller-insights
ls libs/common/src | grep -xE 'discussions|feed|stories|notifications|search-admin|autocomplete|recommendations|trending|leaderboards|seller-stats|crawler'   # expect: nothing

# 2. Types, unit tests, registry
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # exit 0
npx jest --ci   # 30/31 suites, 130 tests; the only failure is libs/domains/community/domain/ranking.spec.ts
npx jest --ci libs/domains/community/domain/ranking.spec.ts 2>&1 | grep "Must use import"   # same marked ESM error as before
npx jest --ci db/   # 5 passed

# 3. Boundaries and runtime graph
grep -rnE "['\"]@app/domains/[a-z0-9-]+/" --include=*.ts apps libs test   # no output
pnpm check:module-graph   # ✓ ×9, same node counts as batch 3

# 4. Builds and e2e discovery
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # 52

# 5. Re-apply guard
bash scripts/refactor/phase2-move.sh scripts/refactor/phase2-batch4-moves.tsv --dry-run   # "Batch already applied", exit 1
```
