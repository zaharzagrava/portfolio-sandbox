# Quickstart: Verify Phase 3

Run everything from `packages/backend`. Nothing here starts a server or a database.

```bash
# 1. Legacy is gone
ls libs/common/src 2>&1                  # expect: No such file or directory
grep -rn "libs/common/src" tsconfig.json package.json jest-e2e.json nest-cli.json scripts/build-lambdas.mjs   # expect: no output

# 2. Types, unit tests, registry
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # expect: exit 0
npx jest --ci             # expect: 31/32 suites, 154 tests; the only failure is ranking.spec (marked ESM, pre-existing)
npx jest --ci db/         # expect: 5 passed

# 3. Runtime and structure checks
NODE_ENV=test pnpm check:module-graph    # expect: ✓ ×9 (one process per app)
NODE_ENV=test pnpm check:model-registry  # expect: ✓ ×10
pnpm check:boundaries                    # expect: exit 0; 62 x5-no-circular warnings (recorded debt)
pnpm check:table-ownership               # report only (D-7/D-12)

# 4. Builds
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # expect: 52
```
