# Quickstart: Verify Phase 1

All commands run from `packages/backend`. None of them start a server or database.

## 1. Layout

```bash
ls libs/infrastructure            # 25 libs (aws … stripe)
ls -d libs/common/*/              # 11 common libs + src/ (legacy domains)
ls libs/composition               # bff
ls libs/common/src/bff            # only batch-read.controller.ts (Phase 2, debt D-4)
```

Expected: no folder from the domain map's §1.2 or §1.3 remains in `libs/common/src`, except the
legacy items listed in [plan.md](plan.md#phase-2-debt).

## 2. Types

```bash
rm -f tsconfig.tsbuildinfo && npx tsc --noEmit -p tsconfig.json   # expect: no output, exit 0
```

## 3. Unit tests

```bash
npx jest --ci   # expect: 29/30 suites, 125/125 tests; only discussions/ranking.spec.ts fails (pre-existing)
```

## 4. Bundlers resolve the new aliases

```bash
npx nest build bff && npx nest build core          # expect: webpack compiled successfully
npx jest --config jest-e2e.json --listTests | wc -l # expect: 52
```

## 5. No stale aliases to moved libs

```bash
# Expect no output: every lib whose alias changed is imported through its new path.
# (logging, telemetry, exceptions-filter, lifecycle, load-shedding, platform keep `@app/common/<name>`.)
grep -rnoE "@app/common/(redis|kafka|sqs|dynamo|cassandra|clickhouse|elasticsearch|storage|aws-api|firebase|stripe|http-client|request|net|outbox|outbox-dto|events|projections|jobs|cron|realtime|cache|rate-limit|idempotency|health|database|context|api-config|bff/bff|utils/(core|money|db-utils|config-utils|error-utils|ts-node-utils))\b" --include=*.ts apps libs test
```

## 6. Rollback

The change is uncommitted: staged `git mv` renames plus unstaged edits. From the repo root:

```bash
git status --short | grep -v '^??'   # confirm only Phase 1 changes are tracked-and-modified
git reset --hard HEAD                # drops staged renames and edits; untracked files (specs/, scripts/refactor/) stay
```
