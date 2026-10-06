# Gaps: S39 Analytics ingestion and A/B testing (current code vs `spec.md`)

This is the implementation agent's to-do list. Scope is the analytics and experiments half of `experimentation` (S39); flags are S38 and are not listed. Update the existing tests and callers named in `questions.md` (`[BREAKING]`).

Files in scope (under `packages/backend/libs/domains/experimentation/` unless noted): `api/analytics.controller.ts`, `application/analytics.service.ts`, `domain/event-schema.ts`, `domain/experiments.ts`, `domain/stats.ts`, `domain/stats.spec.ts`, `infra/purchase-events.projector.ts`, `analytics.module.ts`, `analytics.e2e-spec.ts`, `index.ts`; `packages/backend/clickhouse/070_analytics.sql`; `packages/backend/migrations/20261001320000-experiments.js`; `packages/backend/db/ownership.ts`; `packages/edge-be/src/index.ts` (lines 255–315) and `packages/edge-be/test/index.spec.ts`; `packages/contracts` (no source folder exists yet).

## Behaviour gaps

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | Event identity is `(name, day, event_id)` with `ReplacingMergeTree(received_at)`: a replay whose `ts` was re-clamped, or that arrives with a different name, is another key and counts twice; a later copy overwrites the first | `clickhouse/070_analytics.sql` (`ORDER BY (name, toDate(ts), event_id)`), `analytics.service.ts:75-86` (`FINAL` only collapses equal keys) | FR-010, AS-12, AS-44 |
| G2 | No endpoint to start, stop, list, read or audit experiments; one `PUT` sets any status in any order (a stopped test restarts, `stoppedAt` is reset), definition changes on conflict are silently ignored while `204` is returned, no `expectedVersion`, no history row | `analytics.service.ts:112-123`, `analytics.controller.ts:41-46` | FR-022, FR-023, FR-026, AS-30 – AS-41 |
| G3 | No input validation for experiments: the body is a TypeScript `Omit<ExperimentDef,…>` with no DTO or schema, so bad input reaches SQL and surfaces as a `500` (check-constraint and exclusion-constraint errors are not mapped to `422` / `409 layer_range_conflict`); no limits; no `owner`, `unit`, version, `createdAt`/`updatedAt`/`startedBy`/`stoppedBy` columns; no history table | `analytics.controller.ts:41-46`, migration `20261001320000-experiments.js` | FR-020, FR-021, FR-026, AS-32, AS-36, AS-37 |
| G4 | Weights are any positive numbers scaled as a float (`total / 10_000`); falls back to the last variant on rounding | `domain/experiments.ts:22-29` | FR-020, FR-024, AS-18 |
| G5 | `assign` calls `murmur3` directly; S38's `bucketOf(salt, unit)` is the single hash and S39 must use it with salts `"layer:<layer>"` and `"exp:<key>"` (same values as today) | `domain/experiments.ts:20,23`; `domain/evaluator.ts:53` | FR-024, AS-17 |
| G6 | Assignment endpoint: unvalidated `X-Anonymous-Id`, result shape `{key: variant}`, no `Cache-Control`/`Vary`, no rate limit, a database or cache failure is a `500`, units mixed (`user id ?? header`) with no `unit` concept | `analytics.controller.ts:34-39`, `analytics.service.ts:49-63` | FR-030, FR-031, AS-20 – AS-24 |
| G7 | Results: no window end (`stoppedAt`), a unit exposed to two variants counts under the first, no crossover or unknown-variant exclusion, comparison always shown even when SRM mismatches, no minimum sample, no interval, no Bonferroni, `relativeLift` is `0` when the control rate is `0` (should be `null`), no `asOf`/window fields, ClickHouse failure is a `500` with no timeout, results use `if(user_id != '', user_id, anonymous_id)` for every experiment | `analytics.service.ts:71-107`, `domain/stats.ts:26-34` | FR-040 – FR-045, AS-42 – AS-53 |
| G8 | Ingest: error text is a zod message (`rejected: [{index, error}]`) not a code; no `forbidden_field` (body `user_id`/`country`/`platform` are silently ignored); `anonymous_id` accepts any characters; props accept any key; `ts` accepts negative numbers; no `duplicate_in_batch`; exposure shape unvalidated; no `413`/`415`; text/plain parse errors are a bare `BadRequestException`; the Kafka produce has no timeout and a failure is an unhandled `500` with some events possibly sent; no metrics | `domain/event-schema.ts:12-23,43-60`, `analytics.service.ts:26-40`, `analytics.controller.ts:16-33` | FR-001 – FR-007, AS-02 – AS-08 |
| G9 | Ingest uses the `search.query` policy (60/min, shared with search) and `skipThrottle: true`; no dedicated policies `analytics.ingest`, `experiments.assignments`, `experiments.admin.write`, `experiments.results` | `analytics.controller.ts:17-18`; `libs/infrastructure/rate-limit/rate-limit.types.ts:40` | FR-008, FR-026, FR-030, FR-045, AS-09, AS-22, AS-41, AS-53 |
| G10 | `country` and `platform` come straight from `cf-ipcountry` and `x-client-platform` with no edge-credential check and no platform enum | `analytics.controller.ts:30` | FR-004, AS-11 |
| G11 | Edge collector differs from the backend: nested props become `"[object Object]"`, props beyond 30 and values over 500 are cut silently instead of rejected, `anonymous_id` characters unchecked, `props` key rules missing, events beyond 50 are dropped silently (`slice(0, 50)`), no body-size limit, no rate limit, no `forbidden_field`, no `duplicate_in_batch`, produce failure is only logged once (no retry, no metric), the comment names a stale path (`libs/common/src/analytics/event-schema.ts`) | `packages/edge-be/src/index.ts:255-310` | FR-009, FR-007, AS-10 |
| G12 | Purchase projector: invalid payloads are filtered out silently (no dead letter); `received_at` from `new Date()` (not the injected clock); direct sink insert with no test of redelivery | `infra/purchase-events.projector.ts:24-43` | FR-013, AS-15 |
| G13 | Server exposure path `logExposure` writes events with `platform: 'server'` outside validation and has no caller | `analytics.service.ts:43-47` | FR-032 (removed) |
| G14 | No `storedAnalyticsEventSchema` or any other analytics/experiment schema in `packages/contracts` (the package has no source folder); response DTOs do not exist (raw rows and ad-hoc objects are returned) | `packages/contracts` | FR-052, V.1, V.2 |
| G15 | No metrics (`analytics_*`, `experiment_*`); no structured log lines for admin writes; logging policy for props/user ids not enforced | n/a | FR-051, AS-54, AS-55 |
| G16 | The old e2e spec calls `AnalyticsService` methods directly (not HTTP), bypasses the topic (inserts straight into ClickHouse), has no `401`/`403`/validation/concurrency/failure cases, and extracts the table DDL by string slicing; it must be replaced by the six files in `test-plan.md` and the extended unit specs | `analytics.e2e-spec.ts` (whole file, setup at lines 31–35) | VII.2, VII.3, VII.4 |
| G17 | `stats.spec.ts` covers four cases only; no confidence interval, Bonferroni, degenerate-count, or property tests; `edge-be/test/index.spec.ts` has no collector cases | `domain/stats.spec.ts`, `edge-be/test/index.spec.ts` | VII.5, AS-42, AS-45, AS-47, AS-48 |

## Layering and boundary gaps (constitution I, II, III, IV, IX, X)

| # | Gap | Where | Rule | Replacement |
|---|---|---|---|---|
| B1 | `application/` runs SQL itself: it injects the Sequelize connection and writes raw SQL for experiments, and builds the ClickHouse results query inline, instead of using `infra/` repositories behind `domain/` port tokens | `analytics.service.ts:2,14-17,49-53,71-95,112-122` | I.2, III.1 | Experiment repository and event-store repository in `infra/`, ports in `domain/`; transactions (conditional update + history row) opened in `application/` |
| B2 | `application/` throws Nest HTTP exceptions (`BadRequestException`, `NotFoundException`); the controller builds HTTP errors with `try/catch` and parses the body | `analytics.service.ts:30,72`, `analytics.controller.ts:16-33` | II.1, II.2 | Domain errors mapped by the global filter; body parsing for `text/plain` in a pipe or raw-body middleware |
| B3 | `domain/event-schema.ts` reads the clock (`now = Date.now()` default) and imports `zod` and builds strings for ClickHouse | `domain/event-schema.ts:43-48` | I.3 | `now` always injected; formatting in the store adapter |
| B4 | Controller declares no response DTOs or contracts schema; module exports `AnalyticsService` although no other module uses it | `analytics.module.ts:13`, `analytics.controller.ts` | V.1, V.2, X.4 | Export only the Nest modules and the event contract constants through `index.ts` |
| B5 | New tables need ownership registry entries | `db/ownership.ts:143` (`Experiment` exists) | IX.3 | Add `ExperimentAudit: 'domain:experimentation'`; migration is expand-only with `lock_timeout` (III.11) |
| B6 | Analytics events are never exposed by an API; keep it that way and keep the ClickHouse tables (`analytics_events`, `analytics_events_queue`, `analytics_events_errors`) owned by `experimentation` only. Discovery reads the stream, not the table | `discovery/infra/trending.consumer.ts:6` imports `ANALYTICS_TOPIC` | IX.4, IX.7 R3 | Keep: event-contract import through the entry point; S35 owns the consumer |

## Debt register rows (open) naming `experimentation` or S39

| Row | What it says for this domain | S39 action | IX.7 mechanism |
|---|---|---|---|
| D-15 (X.5) | `experimentation` is a member of the strongly connected set {catalog, discovery, experimentation, orders, payments}, formed with D-11 and D-12 | S39 adds no domain edge. Its edge to `orders` is the `OrderPaid` event contract (R3 projector, `purchase-events.projector.ts:6`); discovery's edge to it is the `ANALYTICS_TOPIC` constant (R3 stream, S35). Neither is removed by S39; closing D-11 and D-12 (S05, S10, S13, S32) breaks the set | R3 (stream and projector); nothing replaced here |
| D-7 (IX.4) and D-12 (IX.4) | No row names `experimentation`; the live list is the `MODEL` / `SQL` output of `pnpm --dir packages/backend check:table-ownership` | See the next section | — |

No other open row of `docs/architecture/debt-register.md` names `experimentation` or S39 (rows D-1 … D-6, D-8 … D-11, D-13, D-14, D-16, D-17 do not mention it).

## `check:table-ownership` lines for `experimentation`

The command (`pnpm --dir packages/backend check:table-ownership`) could not be run in this session (the sandbox requires approval for it), so the report was not read. The code was inspected instead:

- Queries by this capability's code reference only `"Experiment"` (`analytics.service.ts:51,72,114`; owned by `domain:experimentation` in `db/ownership.ts:143`), `"FeatureFlag"` and `"FlagAudit"` (S38; owned by experimentation). No `InjectModel`, `forFeature`, association or `*Model` import of another domain's table exists in the domain folder, so the expected finding count for S39 is **0 `MODEL` and 0 `SQL` rows**.
- The raw SQL string in `analytics.service.ts:51` uses `"layerFrom"`, `"layerTo"` and `metric`; after B1 the SQL moves to the repository and uses only `Experiment` and `ExperimentAudit`.
- The ClickHouse queries (`analytics_events`) are outside the Postgres registry; they remain inside the owning domain after B1.
- **First action of the implementation agent:** run the command, copy any `experimentation` lines into this table, and for each name the mechanism: lookups of users or shops → R1 (`identity`/`tenancy` exported service); anything searched or combined across domains → R3; client screens → R2. Expected result: none.

## Suggested order

1. B1, B2, B3: ports and repositories; domain errors; injected clock (nothing else can be tested through HTTP before this).
2. `packages/contracts` schemas (G14) and the shared vector fixture (G11).
3. Migration (experiments columns, history table, backfill `unit`, rescaled weights, `owner`) and ClickHouse DDL change (G1, G2, G3), registry entry (B5).
4. Assignment through `bucketOf` and integer weights (G4, G5), endpoint hardening (G6).
5. Ingest hardening, codes, limits, policies, metrics (G8, G9, G10, G15); edge parity (G11).
6. Lifecycle endpoints and history (G2, G3).
7. Results (G7) with the new statistics (G17).
8. Purchase projector (G12), remove `logExposure` (G13), exports (B4).
9. Replace the old e2e with the files in `test-plan.md` (G16); run the static gates; record the green run (VII.9).
