# Quickstart: Verify Phase 2 Batch 2

All commands run from `packages/backend`. None of them start a server or database.

```bash
# 1. Layout: the 12 legacy folders are gone; the 5 domains exist
ls libs/common/src | grep -xE 'orders|bis-order|payment|payment-dto|ledger|finance|chat|chat-dto|chat-sync|pickup|delivery|onboarding'   # expect: nothing
ls libs/domains   # catalog chat fulfilment identity orders payments seller-onboarding tenancy

# 2. Types, unit tests, registry
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # expect: exit 0
npx jest --ci        # expect: 30/31 suites, 130 tests; only discussions/ranking.spec.ts fails (pre-existing)
npx jest --ci db/    # expect: 5 passed (placement covers 20 domain models)

# 3. Single entry point (X.4)
grep -rnE "['\"]@app/domains/[a-z0-9-]+/" --include=*.ts apps libs test   # expect: no output

# 4. Runtime module graph: catches barrel cycles that tsc can't see
pnpm check:module-graph   # expect: ✓ ×9 (payment-processor 34, worker 227 modules/classes)

# 5. Infrastructure no longer imports domains through Stripe
grep -n "@app/domains" libs/infrastructure/stripe/*.ts   # expect: no output

# 6. Builds
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # expect: 52

# 7. Re-apply guard
bash scripts/refactor/phase2-move.sh scripts/refactor/phase2-batch2-moves.tsv --dry-run   # expect: "Batch already applied", exit 1
```
