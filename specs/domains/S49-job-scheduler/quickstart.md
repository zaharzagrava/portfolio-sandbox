# Quickstart: validating S49

Run from `packages/backend`. Test DB per `docker-compose.test.yaml`. Shapes: [contracts/](contracts/), tables: [data-model.md](data-model.md).

## Fast loop (narrowest proof first)

```bash
# pure logic, no DB
pnpm jest libs/infrastructure/jobs --testPathPattern 'spec\.ts$' --testPathIgnorePatterns e2e
# one e2e file at a time (condensed output; full log path is printed)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/jobs/jobs-enqueue.e2e-spec.ts
```

## Scenario map

| Scenarios | Command (via `test-spec.sh`) | Expected |
|---|---|---|
| AS-01–06, 08 | `jobs-enqueue.e2e-spec.ts` | rows and results as spec |
| AS-10–17, 19–24 | `jobs-worker.e2e-spec.ts` | 1,000 jobs once each; backoff windows |
| AS-25–37 | `jobs-lease.e2e-spec.ts` | fencing, reaper, shutdown release |
| AS-39–45 | `jobs-state.e2e-spec.ts` | one winner in each race |
| AS-46–52 | `jobs-fairness.e2e-spec.ts` | sampled running count ≤ 5 |
| AS-53–67 | `jobs-cron.e2e-spec.ts` | one job per fire, isolation, auto-disable |
| AS-77–83 | `jobs-observability.e2e-spec.ts` | metrics, logs, pagination |
| AS-09, 84–90 | `jobs-retention.e2e-spec.ts` | partitions, key purge, plans |
| AS-91–94, S54 purge follow-up | `jobs-registry.e2e-spec.ts` | boot failures; `platform.purge-idempotency-keys` registered in the worker |
| AS-18, 38, 68–76, 82 (cursor), 92, 93, 95 | unit specs beside code | table-driven |

## Static gates

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm lint
pnpm check:boundaries
pnpm check:table-ownership --strict      # record any `jobs` line in the report
pnpm check:no-wallclock                  # jobs code uses the injected Clock
```

Also grep that `sequelize.transaction` count in `libs/infrastructure/jobs` is 0 and no `// S54 T037 audit` remains there.

## Whole capability suite (once, at the end)

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/jobs
```

## Ops artifacts (not proven by an automated test; status `not run`, see `specs/UNVERIFIED.md`)

- **SC-002**: `pnpm loadtest:jobs` at 1, 2, 4 workers; drain time within 30% of linear, zero re-executions.
- **SC-006**: schedule materialises within 2 s of due and delayed job starts within 1 s of `runAt` under normal load; measure with `job_queue_lag_seconds` during `loadtest:jobs`.
- **SC-007**: queue lag visible within 10 s of becoming non-zero; scrape `/metrics` with workers stopped.
- **AS-88 / AS-89 at full scale** (200,000 rows, 5,000 cycles): CI runs a reduced size; the full run is on the runner.
- **AS-88 / AS-89 sizes**: `jobs-retention.e2e-spec.ts` reads `S49_PLAN_ROWS` (default 20,000) and `S49_HOT_CYCLES` (default 500); the full run is `S49_PLAN_ROWS=200000 S49_HOT_CYCLES=5000 /opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/jobs/jobs-retention.e2e-spec.ts`. AS-89 currently fails by design conflict, see the BLOCKER section of [questions.md](questions.md): a status change can never be a heap-only update while the claim path needs a partial index on `status`.
- **Foreign specs updated to the test probe** (`onboarding`, `webhooks`, `notifications` e2e): `onboarding.e2e-spec.ts` passed; `webhooks.e2e-spec.ts` and `notifications.e2e-spec.ts` need Cassandra (`Keyspace 'marketplace' does not exist` in this sandbox, `localhost:9042` refused) and could not run here. Run both where the keyspace exists (`pnpm cql:migrate`).

## Baseline recorded by T001 (before any change)

- `pnpm exec tsc --noEmit`: clean. `pnpm check:boundaries`: 62 warnings, 0 errors. `pnpm check:table-ownership --strict`: 87 cross-domain accesses in 21 domains, no line for `infrastructure/jobs` (the string-built `DROP TABLE` of G-24 is not detected by the checker; it was found by grep).
- `grep -rn "sequelize.transaction" libs/infrastructure/jobs`: one site, `job-maintenance.service.ts:76` (the materialiser). Direct-transaction count of the domain: 1. After the work: 0, and no `// S54 T037 audit` marker left.
