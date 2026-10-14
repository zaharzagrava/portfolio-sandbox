# Research: S39 — Analytics ingestion and A/B testing

No `NEEDS CLARIFICATION` remains. Every item is a decision with its reason; facts marked **(verified)** were read in the code on 2026-10-14, the others are design choices.

## Decisions

### R-1 Event identity and dedupe (G1, FR-010, AS-12, AS-44)
- **Decision**: a new plain `MergeTree` table `analytics_event_log`, no `ReplacingMergeTree`. Every read collapses copies with `GROUP BY event_id` and `argMin(<column>, tuple(received_at, ts, name))`, so the first received copy is the one read, whatever a later copy says.
- **Rationale**: the table is partitioned by event day and a copy with a re-clamped `ts` lands in another partition, where no merge can see the first copy; a `ReplacingMergeTree(received_at)` keeps the **latest** row, which is the opposite of the spec. S36 reached the same conclusion for its click log (`081_ads_v2.sql`). Read-time collapse is correct before, during and after any merge.
- **Alternatives**: `ReplacingMergeTree` with a version of `max − received_at` (still per partition, so still wrong across days); `FINAL` (collapses equal sort keys only, the current defect); an insert-time check against Postgres or Redis (a second store on the hot path, and a lost write would leave a hole).
- **Cost**: reads scan more rows. Bounded by R-2.

### R-2 Which rows a results read has to scan (FR-040, SC-006)
- **Decision**: the candidate set is `SELECT event_id FROM analytics_event_log WHERE name IN ('exposure', :metric) AND received_at >= :startedAt − 10 minutes`; the collapse then runs on **all** rows of those ids (any name, any day), and the window test (`ts` between `startedAt` and the window end) is applied **after** the collapse, on the first copy's `ts` and `name`.
- **Rationale**: an event with event time `≥ startedAt` was received at `≥ startedAt − 10 minutes`, because a client time more than 10 minutes ahead is replaced by the receive time (FR-005) and an earlier one was sent after it happened. A later copy with another name must not be able to turn a `page_view` into an exposure, hence the collapse over the ids, not over the name filter.
- **Alternatives**: filter by `ts` (misses a re-clamped first copy); collapse over the whole table (a full scan per read).

### R-3 One rule set for both runtimes (FR-009, AS-10, G11)
- **Decision**: `packages/contracts/src/analytics/ingest-rules.ts` is a dependency-free module (no zod, no Node API) exporting `INGEST_CODES`, `CLIENT_EVENT_NAMES`, `validateIngestEvent(raw, now)`, `clampTs(ts, now)`, `toStoredShape`, the exposure shape check and the flat-props flattener. The backend wraps it in `domain/event-schema.ts`; the worker imports it; `ingest-vectors.json` (input, `now`, expected per-event outcome) is read by `analytics-ingest.e2e-spec.ts` and `edge-be/test/collect.spec.ts`.
- **Rationale**: "one shared definition and one shared table of vectors" (FR-009). A hand-mirrored copy is the current defect (the comment names a path that no longer exists).
- **Alternatives**: duplicate with vectors only (drift is caught late); an HTTP call from the edge to the backend (defeats the edge).

### R-4 Reading the body at the fallback (FR-006, AS-04, AS-06, B2)
- **Decision**: **(verified)** the core app boots with `rawBody: true` and the platform parser already bounds bodies at 1 MiB and maps parser errors to `malformed_body`. `IngestBodyGuard` (a copy of S38's `BodySizeGuard` with 128 KiB and a content-type check) answers `413` / `415` before validation; `IngestBodyPipe` turns `text/plain` raw bytes into JSON and answers `400 validation_failed` for non-JSON. The controller keeps no `try/catch`.
- **Rationale**: II.1 and II.2: guards for coarse checks, pipes for parsing; the stream-reading `buffer(req)` goes away.
- **Alternative**: a route middleware with its own parser (a second body parser per route, order-dependent).

### R-5 Ack and retry (FR-007, AS-08, AS-10)
- **Decision**: fallback: produce all accepted events with one `sendMany` bounded by 2 s (`withTimeout`, `domain/with-timeout.ts` exists from S38); any failure or timeout → `503 ingest_unavailable` + `Retry-After: 5`, nothing reported accepted, `analytics_produce_failures_total` +1 per failed request, **no retry in the backend** (the client retries the same `event_id`s, and the store collapses them). Edge: `202` first, `waitUntil` produce with 3 attempts, full-jitter backoff (base 100 ms, cap 1 s), `analytics_edge_produce_failures_total` +1 per finally failed **event**.
- **Rationale**: IV.6 retries at exactly one layer; the browser retries a fallback failure, the edge retries its own background work.
- **L-001**: the topic is standard; the producer wrapper accepts no `groupId`, and a unit-level assertion in the ingest e2e checks the sent message has only `key`/`value`.

### R-6 Experiment writes (G2, G3, FR-022, FR-023, FR-026, AS-30 – AS-39)
- **Decision**: `ExperimentCommandService` opens one `TransactionRunner.run`. Order of locks: (1) a transaction-scoped advisory lock `pg_advisory_xact_lock(hashtext('experiments'))` for create only, which also makes the 200 cap exact (III.6); (2) `SELECT … FOR UPDATE` of the row. The pure `decide(current, command, now)` returns `noop | apply(next, action) | error(code)`. Apply = conditional update `WHERE key = :k AND version = :v` (assert one row) or `WHERE key = :k AND status = :from` for start/stop, plus one `ExperimentAudit` insert, same transaction. Start and stop repeats return before any write. Concurrent starts of overlapping drafts are decided by the `EXCLUDE` constraint, whose violation (`23P01`) is mapped to `409 layer_range_conflict` naming the blocking key (read inside the failed attempt by a second query after rollback, outside the transaction).
- **Rationale**: III.6/III.7; the version column is the only thing that makes "two admins never overwrite each other" true, and the constraint is the only thing that makes "two parallel starts" true.
- **Alternatives**: a global lock for every write (S38 does that; here only create needs a count, so the row lock is enough and parallel updates of different experiments proceed); application check-then-write (forbidden).

### R-7 Definition validation (FR-020, FR-021, AS-32)
- **Decision**: two stages. Shape (types, key pattern, unknown fields) by the contracts schema `experimentWriteSchema` through the zod pipe → `400 validation_failed`. Meaning by pure `validateDefinition` → every problem at once as `422 experiment_definition_invalid {errors:[{path, code}]}` with the ten codes of AS-32. Unknown fields are rejected by `.strict()`.
- **Alternative**: one stage in zod (cannot list semantic problems together with paths in the closed code list).

### R-8 Edge import of the shared rules (G11)
- **Decision**: the worker imports `../../contracts/src/analytics/ingest-rules.ts`; wrangler's bundler follows relative imports and the file has no imports. Task T-edge starts by proving `vitest` (workers pool) and `wrangler deploy --dry-run` accept it. **Fallback if either refuses**: copy the file verbatim to `packages/edge-be/src/ingest-rules.ts` and add one test that compares the two files byte for byte (hash) plus the shared vectors.
- **Rationale**: the worker has its own lockfile and no workspace link to `packages/contracts`.

### R-9 Edge rate limit (FR-008, AS-10, G9, G11)
- **Decision**: **(verified)** `edge-be/src/index.ts` already has `checkRateLimit(subject, env)` (S50: 120 per 60 s sliding window, 500 ms timeout, fail open counted in `edgeRateLimitStats`) applied only to proxied GET reads. `POST /collect` calls the same function with the same subject (`rateLimitSubject`) before reading the body, answers the existing `rateLimitResponse` (`429` + `Retry-After`), and counts nothing else. The policy name in the structured header stays the edge's.
- **Rationale**: no second limiter; FR-008 wants "the same at the edge".

### R-10 Running-set cache (FR-031, AS-23, AS-24, B1)
- **Decision**: port `RUNNING_SET_CACHE` with `get(loader)` and `invalidate()`. Adapter: per-instance memory 10 s (`l1TtlMs`), shared cache key `experiments:running` TTL 30 s (existing values), loader = repository `listRunning()` under a 500 ms timeout. A write invalidates the shared key and the writer's own memory entry **after commit**. Staleness bound: the other instance's memory entry lives ≤ 10 s, then it reloads from the invalidated cache → ≤ 15 s (AS-24). Cache error → database; database error or timeout → `degraded: true`, empty map.
- **L-016**: the loader catches the cache error it is repairing.
- **Alternative**: Redis pub/sub for instant invalidation (must-deliver data on pub/sub is forbidden, IV.3).

### R-11 Statistics (FR-041, FR-042, AS-42 – AS-48)
- **Decision**: keep `normalCdf`, `chiSquarePValue`, `srmCheck` (add exact-split guard: chi-square 0 → p 1) and extend `twoProportionZTest` into `compareToControl(control, treatment, alpha)` returning `{absoluteDifference, relativeLift|null, zScore, pValue, confidenceInterval95, significant}`; pooled for z and p, unpooled for the interval (z = 1.959964), all finite for any non-negative counts (`fast-check`). `alpha = 0.05 / (variants − 1)`. `domain/results.ts` applies the verdict order: `no_data` → `insufficient_sample` (any arm < 100) → `withheld_untrustworthy` (SRM or crossover > 1 %) → `available`.
- **Note**: the normal CDF approximation has error < 1.5e-7; the AS-42 assertions use `< 0.001`/CI bounds, not exact p digits.
- **Alternative**: a stats library (a new dependency for 60 lines of tested maths).

### R-12 Link and discussion events (S37 follow-up, `[CONTRACT]` in questions.md)
- **Decision**: S39 subscribes to neither `links.events` nor `discussion.post_created`. **(verified)** S37's contract is `link.clicked` **v1** with an origin-only `referer`; version 1, not 0, is the fact to use when a link-analytics capability is specified. A subscription needs a consumer, a DLQ, an idempotency key and a new domain edge to `marketing`, and no requirement or scenario of this spec asks for it.
- **Consequence**: nothing to build or test; `gaps.md` records the fact for the next spec.

### R-13 `order.paid` payload naming (FR-013, AS-15)
- **Decision**: **(verified)** the code's contract (`packages/contracts/src/orders/order-events.ts`) calls the amount `totalMinor` and the payment reference `paymentRef`; the spec's "Requires" text says `total` and `paymentId`. The projector reads `totalMinor` (integer minor units) and writes it as the string prop `total`; `order_id` is the envelope's `aggregateId`; `currency` is the payload's (default `usd`). The spec's names are descriptive, the contract's names are binding; `gaps.md` notes the drift for the spec editor.
- **Invalid payload**: `OrderPaid.match` is replaced by `OrderPaid.schema.safeParse` per envelope; a failure goes to S53's `DeadLetterWriter` (reason = zod paths, never values) and `analytics_dead_letter_total{source="purchase-projector"}` +1; the batch continues. `received_at` comes from the injected `Clock`.
- **Writer**: insert into `analytics_event_log` through `ClickHouseSink` with an insert dedup token `purchase:<eventId>` (a second delivery is a no-op or, at worst, a duplicate row that R-1 collapses).

### R-14 Projector module (D-8, D-15)
- **Decision**: **(verified)** `apps/projector/src/projector.module.ts` registers other capabilities' projectors through `<X>ProjectorModule.projectors`. S39 adds `AnalyticsProjectorModule` the same way and removes `PurchaseEventsProjector` from the barrel. `OrderPaid` stays imported from `@app/domains/orders` (D-15 edge unchanged, R3).

### R-15 `storedAnalyticsEventSchema` (S35 follow-up, FR-003, FR-052)
- **Decision**: **(verified)** it exists (`contracts/src/analytics/stored-event.ts`, used by `trending-ingest.service.ts` which dead-letters on any schema violation). Extend, do not replace: names + `video_view` + `purchase`; explicit `country`, `platform`, `page`; `anonymous_id` 8–64, or `""` when `name = purchase` (refinement); `props` record of strings. `video_view` messages must not be dead-lettered by S35 once S30 emits them.
- **Check**: S35's `trending-contracts.spec.ts` and `normalise` run after the change; a name the trending counter does not count must be "ignored", not "invalid" (if not, that is S35's follow-up bullet, not an edit of S35 here).

### R-16 Migrations (III.11, G1, G3, B5)
- **Postgres** (`<next>-experiments-lifecycle.js`, `lock_timeout`, expand only): add `owner TEXT NOT NULL DEFAULT 'unknown'`, `unit TEXT NOT NULL DEFAULT 'user' CHECK (unit IN ('user','visitor'))`, `version INTEGER NOT NULL DEFAULT 1`, `startedBy`, `stoppedBy` (nullable text), `updatedAt TIMESTAMPTZ NOT NULL DEFAULT now()`, create `ExperimentAudit` (`id UUID`, `experimentKey`, `action` check, `actorId NOT NULL`, `requestId`, `before JSONB`, `after JSONB NOT NULL`, `at`; index `(experimentKey, at DESC, id DESC)`; immutability through the API is: the repository has an insert and reads, no update or delete method, and no endpoint writes it; no trigger, as for `FlagAudit`), rescale legacy weights to integers summing to 10,000 (largest remainder; a row that cannot be rescaled keeps its weights and is reported), keep the exclusion constraint, add `CHECK (jsonb_array_length(variants) BETWEEN 2 AND 10)`. The status values stay `DRAFT/RUNNING/STOPPED` in the table; the API lowercases them.
- **ClickHouse** (`072_analytics_dedupe.sql`, idempotent statements): create `analytics_event_log`, drop and recreate `analytics_events_mv` `TO analytics_event_log`, backfill `INSERT INTO analytics_event_log SELECT … FROM analytics_events` guarded by `WHERE event_id NOT IN (SELECT event_id FROM analytics_event_log)` so a re-run adds nothing, keep `analytics_events` and `analytics_events_errors`. Removal of the old table is a later file.
- **Statement splitter**: **(verified)** `scripts/clickhouse/migrate.ts` splits on `;` at end of line and strips `--` comments; the file must not put `;` inside strings.

### R-17 Assignment arithmetic (FR-024, AS-17 – AS-19)
- **Decision**: `layerBucket = bucketOf("layer:"+layer, unit)`; in range when `layerFrom ≤ layerBucket < layerTo`; `variantBucket = bucketOf("exp:"+key, unit)`; walk variants with an integer cumulative sum; weights are validated to sum to 10,000 so the loop always returns, and a safety branch (`assertNever`-style unreachable) throws if not. The first variant is control. The reference-vector table is computed once from today's murmur3 values (they do not change: the salts are the old strings) and pinned in `experiments.spec.ts`.
- **Performance**: all 100 running experiments evaluated per request, two hashes each; SC-004 is a benchmark (ops artifact).

### R-18 Logs and metrics (FR-051, AS-54, AS-55)
- **Decision**: the nine metrics are created once in `analytics-metrics.ts` with the S54 registry; labels are the closed code lists. Logging uses the request logger; the ingest and assignment paths log only counts and codes; the admin writes log `{event:'experiment_write', action, key, version, actorId?}`. User ids are **not** logged (AS-55 forbids `user_id`), so the admin line carries the key and the audit row id, not the actor id. The anonymous id prefix (4 chars) is logged only on rejected-event debug lines.

### R-19 The existing browser contract (`client-events.ts`)
- **Decision**: **(verified)** `packages/contracts/src/events/client-events.ts` (W02's, its comment names S39) already exports `CLIENT_EVENT_NAMES` (eight names incl. `video_view`), `clientEventSchema` and `clientEventBatchSchema`, and `packages/web/lib/api/events.ts` posts to same-origin `/api/events` (beacon as `text/plain`, keep-alive `fetch` otherwise) and ignores `rejected`. S39 does not edit it. `ingest-rules.ts` owns the server's rule list; a contracts drift spec asserts that `CLIENT_EVENT_NAMES` equals the rules' name list and that every event the browser schema accepts is judged by the rules (the browser schema may be looser, never stricter). `stored-event.ts` imports the name list from the rules file instead of keeping `ANALYTICS_EVENT_NAMES` as a third copy; the old constant stays exported as an alias because S35 imports it.
- **Follow-ups (gaps.md)**: W02 tightens `anonymous_id` to `[A-Za-z0-9_-]` and may read `rejected[].code`.

## Gap traceability

| Gap | Resolved by |
|---|---|
| G1 | R-1, R-2, R-16 |
| G2, G3 | R-6, R-7, R-16 |
| G4, G5 | R-17 |
| G6 | R-10, `experiments-api.md` assignments |
| G7 | R-2, R-11 |
| G8 | R-3, R-4, R-5 |
| G9 | plan follow-up 5, R-9 |
| G10 | `ingest-context.ts` (edge credential via S38's `factsFromRequest` check, enum platform) |
| G11 | R-3, R-5, R-8, R-9 |
| G12 | R-13, R-14 |
| G13 | `logExposure` deleted; no caller (verified) |
| G14 | R-15, `contracts/` |
| G15 | R-18 |
| G16, G17 | `test-plan.md`, tasks |
| B1 – B4 | plan Constitution rows 1, 2, 10 |
| B5 | R-16 |
| B6 | unchanged: the ClickHouse tables are read only by `infra/clickhouse-event-store.ts` and the S35 consumer reads the topic |
| D-15 | unchanged, R-14 |

## R-8 outcome (edge import)

Route taken: **relative import**, no copy. `packages/edge-be/src/index.ts` imports `../../contracts/src/analytics/ingest-rules` (the file has no imports). Proven both ways: `vitest run` in the workers pool (92 tests of `test/collect.spec.ts` plus the existing edge specs, 103 passed) and `wrangler deploy --dry-run --outdir /tmp/s39-edge-dryrun` bundled the worker without error (70.51 KiB). The byte-for-byte copy fallback was therefore not needed.

## Implementation outcomes (2026-10-14)

- **T003, callers of the breaking changes.** A search of `packages/web`, `packages/edge-be`, `packages/bff` and every backend domain for `experiments/assignments`, `admin/experiments` and `/collect` found only the old controller and service (deleted), `clickhouse/070_analytics.sql` (comment) and the edge collector (rewritten, T024). `packages/web/lib/api/events.ts` posts to `/api/events` and ignores `rejected`, so the new `{index, code}` shape does not break it. No caller of the old `PUT … 204` or of the old assignments shape exists.
- **T004, test stack.** Postgres: `Experiment` and `ExperimentAudit` exist after `20261014100000-experiments-lifecycle` (applied with `pnpm run db:jest:migrate:up`). ClickHouse: the test database has no `schema_migrations`; every spec creates what it needs from `072_analytics_dedupe.sql` (`applyAnalyticsStore`, the stream objects only for the specs that read the real topic, with the compose network's broker `test_kafka:29192` in place of the dev stack's `kafka:29092`, dropped again in `afterAll`, L-013). Topic `analytics.events`: each spec recreates it (`freshAnalyticsTopic`). No new queue, so `elasticmq.conf` is unchanged (L-002).
- **R-10 deviation, memory layer.** The cache toolkit caps the in-process layer (`l1TtlMs`) at 5 s, not 10 s: `CacheRunningSet` uses 5 s over the shared key (TTL 30 s, deleted on every applied write), so the staleness bound is tighter than the 15 s of the spec.
- **R-4 deviation, invalid JSON.** The platform body parser reads `application/json` before any route code and answers a body that is not JSON as `400 malformed_body` (S54). The ingest route's own `400 validation_failed` therefore covers a `text/plain` body that is not JSON and every bad envelope; an `application/json` body that does not parse is the platform's `malformed_body`. Both are `400` problem+json with a stable code.
- **R-13 refinement, purchase projector.** The consumer framework (S53) routes each envelope and validates its payload against `OrderPaid` before `project` runs, and dead-letters a bad one itself (`dlq_total{consumer="analytics-purchases"}`). The projector therefore validates a second time (a payload that reaches it unvalidated is dead-lettered with `analytics-purchases.dlq` and counted in `analytics_dead_letter_total{source="purchase-projector"}`); a dead letter written by the framework is counted by S53's own metric.
- **FR-012 counting.** ClickHouse's stream engine writes unparsable messages to `analytics_events_errors` without the application knowing. `StoreDeadLetterWatcher` (job `analytics.watch-dead-letters`, every 30 s, one run across the fleet, `AnalyticsWorkerModule` in `apps/worker`) counts the new rows into `analytics_dead_letter_total{source="store"}`.
- **Excluded counts.** `excluded.unattributable` and `excluded.unknownVariant` count exposure events (collapsed copies), `excluded.crossoverUnits` counts units; the share tested against 1 % is crossover units over (counted units + crossover units).
