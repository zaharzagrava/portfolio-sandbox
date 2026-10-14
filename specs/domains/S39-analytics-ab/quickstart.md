# Quickstart: validating S39 — Analytics ingestion and A/B testing

Run backend commands from `packages/backend`. Contracts: [ingest-api.md](contracts/ingest-api.md), [experiments-api.md](contracts/experiments-api.md). Tables and DDL: [data-model.md](data-model.md).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`: Postgres, Redis, Kafka, ClickHouse, ElasticMQ) with the Postgres migrations applied (`pnpm test:stack:migrate`) and the ClickHouse migrations applied (`pnpm clickhouse:migrate`, which runs `072_analytics_dedupe.sql`); topic `analytics.events` exists.
- First action of the implementation: `pnpm check:table-ownership` and copy any `experimentation` lines into `gaps.md` (expected: none).

## Automated validation (narrowest first)

```bash
# pure logic (unit)
pnpm jest libs/domains/experimentation/domain/event-schema.spec.ts libs/domains/experimentation/domain/experiments.spec.ts \
  libs/domains/experimentation/domain/experiment-definition.spec.ts libs/domains/experimentation/domain/stats.spec.ts \
  libs/domains/experimentation/domain/results.spec.ts

# API e2e, one file per process (L-008)
/opt/sdd/repo/scripts/sdd/test-spec.sh analytics-ingest.e2e-spec
/opt/sdd/repo/scripts/sdd/test-spec.sh analytics-store.e2e-spec
/opt/sdd/repo/scripts/sdd/test-spec.sh experiments-assignment.e2e-spec
/opt/sdd/repo/scripts/sdd/test-spec.sh experiments-admin.e2e-spec
/opt/sdd/repo/scripts/sdd/test-spec.sh experiments-results.e2e-spec
/opt/sdd/repo/scripts/sdd/test-spec.sh analytics-ops.e2e-spec

# the real applications start with the capability wired in (L-015, L-004)
/opt/sdd/repo/scripts/sdd/test-spec.sh analytics-wiring    # apps/core, apps/worker, the projector composition

# sibling regressions the changes can break
/opt/sdd/repo/scripts/sdd/test-spec.sh trending            # S35 reads the extended stored-event schema
/opt/sdd/repo/scripts/sdd/test-spec.sh flags               # S38 shares bucketOf and the domain barrel

# edge worker (from packages/edge-be)
pnpm vitest run test/collect.spec.ts test/index.spec.ts
```

Expected: every scenario id AS-01 – AS-56 appears in an `it` title of exactly one file of `test-plan.md`; the whole capability suite is run once at the end and the summary line of each file is recorded.

## Static gates

```bash
pnpm tsc --noEmit            # packages/backend, packages/contracts, packages/edge-be
pnpm lint
pnpm check:boundaries && pnpm check:module-graph && pnpm check:model-registry
pnpm check:no-wallclock                  # domain/ files read no clock
pnpm check:table-ownership --strict      # zero findings for experimentation, ExperimentAudit registered
python3 scripts/livespec/check.py        # docs/spec/capabilities/S39-analytics-ab.md proofs and code anchors
```

## Application start (L-015, L-004)

Boot the real `apps/core` and `apps/projector` after the module changes and read the start-up log: `AnalyticsModule` and `AnalyticsProjectorModule` resolve, the four rate-limit policies are registered (no `undeclared policy`), the projector log names `analytics-purchases`. If the sandbox denies starting them, record `blocked` in the notes; do not claim it verified.

## Manual smoke on a fresh stack (L-012)

`scripts/qa/fresh-run.sh`, then:

1. `POST /api/events` with three valid events → `202 {accepted: 3, rejected: []}`; the rows appear in `analytics_event_log` within seconds; posting the same body again leaves `count(DISTINCT event_id)` at 3 and the deduped read at 3.
2. As an admin: `PUT /api/admin/experiments/demo` (`expectedVersion: 0`) → `201`; `POST …/start` → `200`; `GET /api/experiments/assignments` with `X-Anonymous-Id` returns a variant; `POST …/stop`; the next assignment call (after ≤ 15 s) is empty.
3. `GET /api/admin/experiments/demo/results` → `200`, `analysis: "fixed_horizon"`.

## Ops artifacts (criteria no automated test proves)

These are **not verified**; each has one row in `specs/UNVERIFIED.md` with status "not run".

| Criterion | How to run | Pass condition |
|---|---|---|
| SC-001 fallback and edge latency and sustained load | `pnpm --dir packages/backend loadtest:analytics-ingest` (k6, script created by task T-ops: 50-event batches, 2,000 events/s for 10 minutes against the fallback; a separate edge run against `wrangler dev`) | fallback p99 < 200 ms, edge < 50 ms, zero accepted events missing from the store, consumer lag < 10 s |
| SC-004 assignment of 100 running experiments | `pnpm --dir packages/backend bench:assignment` (task T-ops: 100 experiments, 100,000 units, reports p99 per call) | p99 < 5 ms |
| SC-006 results at 1,000,000 exposed units | `pnpm --dir packages/backend bench:results` (task T-ops: seeds 1 M exposures and 100 k conversions into ClickHouse, 100 timed reads) | p95 < 3 s |
| AS-57 one `exposure` per render (UI) | owned by W02's journey `packages/web/tests/storefront-discovery.spec.ts`, which does not exist yet; this capability only proves the exposure is accepted and counted once (AS-25, AS-27) | not proven here; follow-up for W02 |

## Clean-up work scheduled by this plan

- Drop `analytics_events` (frozen by `072`) in a later ClickHouse file no earlier than two weeks after the first deploy of `072` (III.11 contract step); not part of this change.
