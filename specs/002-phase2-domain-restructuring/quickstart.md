# Quickstart: Verify Phase 2 (batch 1)

All commands run from `packages/backend`. None of them start a server or database.

## 1. Layout

```bash
find libs/domains -maxdepth 2 -type d | sort    # identity, tenancy, catalog with their layer folders
ls libs/common/src | grep -E '^(auth|users|users-dto|admin|tenancy|product|product-dto|collab)$'   # expect: nothing
```

## 2. Types and unit tests

```bash
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # expect: exit 0
npx jest --ci   # expect: 30/31 suites, 130 tests; only discussions/ranking.spec.ts fails (pre-existing)
```

## 3. Ownership registry (IX.3)

```bash
npx jest --ci db/   # expect: 5 passed
```

Optional mutation check: change `User: 'domain:identity'` to another domain and re-run. Expect a
failure naming `libs/domains/identity/infra/models/user.model.ts`. Then revert.

## 4. Single entry point (X.4)

```bash
grep -rnE "['\"]@app/domains/[a-z0-9-]+/" --include=*.ts apps libs test   # expect: no output
```

## 5. Runtime module graph (barrel cycles)

```bash
pnpm check:module-graph   # expect: ✓ for all 9 apps (bff 78 … local-monolith 509 modules/classes)
```

## 6. Builds

```bash
for a in bff collab core local-monolith payment-processor projector public-api sse-gateway worker; do npx nest build $a; done
npx jest --config jest-e2e.json --listTests | wc -l   # expect: 52
```
