# Implementation Plan: S39 — Analytics ingestion and A/B testing (domain `experimentation`)

**Branch**: `S39-analytics-ab` (working branch `sdd/auto`) | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-57, FR-001–FR-052, SC-001–SC-007), `test-plan.md`, `gaps.md` (G1–G17, B1–B6, debt D-15, ownership notes), `questions.md` (defaults accepted as written; no line was edited by a human), the constitution (3.1.0), and the follow-ups left by S35, S37, S38 and S50 (below).

## Summary

Rebuild the analytics and experiments half of `experimentation` so that a collector facing the internet says precisely why it rejected an event, no event is counted twice, an experiment cannot be edited into a lie, and a readout withholds its "winner" when the data is broken:

1. **Ingest** (`POST /api/events` fallback and the edge `POST /collect`): one dependency-free rule set, `packages/contracts/src/analytics/ingest-rules.ts` (`validateIngestEvent(raw, {now}) → {ok, event} | {ok:false, code}`, closed code list, clock rules, exposure shapes, prop flattening). The backend (`domain/event-schema.ts` wraps it) and the edge worker (relative import, no new dependency) call the same function, and one JSON fixture of vectors (`packages/contracts/src/analytics/ingest-vectors.json`) is read by the backend e2e and the worker tests (FR-009, AS-10). The fallback answers after the stream acknowledged all accepted events (2 s timeout, `503 ingest_unavailable` + `Retry-After`, nothing reported accepted); the edge answers `202` first and retries the produce 3 times with full-jitter backoff in `waitUntil`, counting final failures.
2. **Store**: events live in a new plain `MergeTree` table `analytics_event_log` (S36's pattern: no `ReplacingMergeTree`, whose "latest wins" merge is the defect). Identity is `event_id` alone; **every read** collapses with `argMin(col, (received_at, ts, name)) … GROUP BY event_id`, so it is correct before any merge, across names, days and re-clamped `ts` (G1). A new ClickHouse file `072_analytics_dedupe.sql` creates it, repoints the stream's materialised views, backfills from `analytics_events` and leaves the old table one release (expand/contract). Dead letters keep `analytics_events_errors` (14 d); stream group `clickhouse-analytics` unchanged.
3. **Experiments** (`apps/core`): thin controllers → `ExperimentCommandService` (`save | start | stop`) and `ExperimentQueryService` (`list | get | history`). One `TransactionRunner.run` per write: lock the experiment row (`FOR UPDATE`; for create, an advisory lock on the key plus the `UNIQUE` key), decide with the pure `domain/experiment-lifecycle.ts` (`assertNever`, no-op detection) and `domain/experiment-definition.ts` (all semantic errors at once), then conditional update asserting one row (`WHERE key = :k AND version = :v` / `AND status = :from`) and one `ExperimentAudit` row in the same transaction. The 200-experiment cap is counted under a transaction-scoped advisory lock (III.6); layer exclusion stays the existing `EXCLUDE USING gist` constraint, mapped to `409 layer_range_conflict`.
4. **Assignment**: `domain/experiments.ts` rewritten with integer weights, `bucketOf("layer:"+layer, unit)` and `bucketOf("exp:"+key, unit)` from the S38 `bucketOf`, per-unit selection by experiment `unit`, no clock. `GET /api/experiments/assignments` reads the running set from a 10 s per-instance memory layer over the shared cache over the database (500 ms DB timeout), answers `{assignments, degraded}`, `Cache-Control: private, no-store`, `Vary`.
5. **Results**: `ExperimentResultsService` asks an `EVENT_STORE` port (ClickHouse adapter in `infra/`, 10 s timeout, read-committed, parameterised) for per-unit first exposure, crossover, unknown variant, unattributable and conversion counts in one query, then pure `domain/results.ts` + `domain/stats.ts` compute rates, pooled z-test, unpooled 95 % interval, Bonferroni, SRM, trust verdict and withheld comparisons.
6. **Operations and contracts**: nine schemas in `packages/contracts/src/analytics` and `…/experimentation/experiments.ts`; four rate-limit policies in `rate-limit-policies.ts` (`analytics.ingest`, `experiments.assignments`, `experiments.admin.write`, `experiments.results`) replacing the borrowed `search.query` and the `skipThrottle`; metrics of AS-54; one structured log line per admin write; `ExperimentAudit` in `db/ownership.ts`; barrel exports the modules and constants only.

Why a plain MergeTree plus read-time `argMin` and not `ReplacingMergeTree`: the partition key is the event day, so a copy whose `ts` was re-clamped lives in another partition and never merges with the first; only a read-time collapse is correct in every case, and then the merge adds nothing but a way to lose the first copy. Why one query for results: the counts must come from one consistent snapshot of the store (`asOf`), and a unit-level scan is the only shape that can find crossover units.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, Sequelize 6 (raw SQL moves into the repository), Postgres 16, ClickHouse (server of the compose stack), Kafka, Redis, Cloudflare Worker (`packages/edge-be`, vitest-pool-workers)
**Primary Dependencies**: `TransactionRunner` (`@app/infrastructure/context`), `CacheService` (`@app/infrastructure/cache`, running-set cache with invalidation, S52), `KafkaProducerService`, `ClickHouseService` (query timeout added by the adapter), `definePolicies` + `@RateLimit` (`@app/infrastructure/rate-limit`), `Clock` (`@app/common/core/clock`), metrics registry (`@app/common/telemetry`), `bucketOf` (own domain, S38), identity `Firewall`/`Role`/`User`, `OrderPaid` event contract (`@app/domains/orders`), `Projector`/`DeadLetterWriter` (`@app/infrastructure/projections`, S53)
**Storage**: PostgreSQL `Experiment` (extended), new `ExperimentAudit` (owner `domain:experimentation`); ClickHouse `analytics_event_log` (new), `analytics_events` (frozen, kept one release), `analytics_events_queue`, `analytics_events_errors`; Redis cache key `experiments:running` (TTL 30 s, invalidated on write); topic `analytics.events` (key `anonymous_id`)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (six files named in `test-plan.md`, replacing `analytics.e2e-spec.ts`), unit specs `event-schema.spec.ts`, `experiments.spec.ts`, `experiment-definition.spec.ts`, `stats.spec.ts`, `results.spec.ts` (pure results assembly), `fast-check` for assignment and statistics; `packages/edge-be/test/collect.spec.ts` (vitest); W02 Playwright journey (AS-57, not owned here)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/projector` (`PurchaseEventsProjector`), Cloudflare edge (`/collect`)
**Project Type**: backend domain module + contracts package + edge worker (admin screens do not exist)
**Performance Goals**: fallback p99 < 200 ms per 50-event batch, edge < 50 ms, 2,000 events/s sustained, assignment of 100 experiments < 5 ms p99, results at 1 M exposed units < 3 s p95: all three are ops artifacts (SC-001, SC-004, SC-006)
**Constraints**: body ≤ 128 KiB, 1–50 events, produce ack 2 s, DB read for assignments 500 ms, results query 10 s, running-set staleness ≤ 15 s (10 s memory + invalidation), 200 experiments, 10 variants, admin writes 30/min, results 20/min, ingest and assignments 120/min
**Scale/Scope**: 200 experiments, 100 running at most per request; events platform-wide (hundreds of thousands per second at the edge, per the notes); retention 400 d events, 14 d dead letters

**Connection arithmetic (III.12)**: S39 opens no new pool. An admin write holds one connection for one short transaction (advisory lock, row lock, update, audit insert, no network I/O; the cache invalidation and the log line run after commit). At 30 writes/min/admin the capability adds at most one connection per concurrent admin write to the shared pool. Assignment reads the database only on a cache miss with a 500 ms timeout (one `SELECT` of ≤ 200 rows). ClickHouse is a separate HTTP client; one results query per admin read, 20/min/admin, 10 s timeout. The pool-size × instances budget is unchanged from the platform's (`DB_POOL_MAX`, S54 plan).

**Maximum staleness accepted (IX.7 R3)**: the purchase read model may lag `order.paid` by the projector's lag; results state `asOf` and are expected to show a new event within 60 s of acknowledgement at nominal lag (FR-044). Purchases never reverse (Assumptions).

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.4) | PASS after work (B1, B2, B3) | ports + tokens in `domain/ports.ts` (`EXPERIMENT_REPOSITORY`, `EVENT_STORE`, `EVENT_PRODUCER`, `RUNNING_SET_CACHE`); adapters in `infra/` (`sequelize-experiment.repository.ts`, `clickhouse-event-store.ts`, `kafka-event-producer.ts`, `cache-running-set.ts`); `application/` imports no `infra/` and no `@nestjs/sequelize`/SQL; `domain/` reads no clock (`now` parameter), imports no Nest/ORM/zod/ClickHouse; the `YYYY-MM-DD HH:mm:ss.SSS` formatting leaves `domain/` for the store adapter and the contracts rule file (pure string work on an injected epoch) |
| 2 Pipeline (II) | PASS after work (B2) | controllers make one call; shape validation of experiment bodies by the contracts schema through a zod pipe (S38's `flag-zod.pipe.ts` pattern); the ingest envelope is parsed by `IngestBodyGuard` (128 KiB → `413`, content type → `415`) and an `IngestBodyPipe` (`text/plain` from `rawBody`), so the controller has no `try/catch`; domain errors (`ExperimentError(code, status, extra)`, `IngestError`) render through the global problem+json filter; `Firewall({anonymous:true})` on ingest and assignments, `Firewall({roles:[ADMIN]})` on admin; limits through `@RateLimit` |
| 3 Data access (III) | PASS after work (B1) | SQL only in `sequelize-experiment.repository.ts` (parameterised, fixed columns, allowlisted sort); transactions by `TransactionRunner.run`; `.tx.baseline` is 0, no `sequelize.transaction` is added and there is no `// S54 T037 audit` comment in this domain's analytics files; no Kafka/Redis/ClickHouse call inside a transaction (invalidation, metric, log after commit); version, state and the 200 cap by conditional update, advisory lock and `UNIQUE`, layer overlap by the `EXCLUDE` constraint; keyset cursors on `(createdAt DESC, key DESC)` and `(at DESC, id DESC)`; cache key has a TTL, no `KEYS` |
| 4 Messaging (IV) | PASS after work | topic `analytics.events` keyed by `anonymous_id` (standard topic, no `groupId`, L-001); the purchase projector validates with the `order.paid` schema and dead-letters through S53's `DeadLetterWriter`; ClickHouse's consumer treats malformed rows as dead letters; every produce has a 2 s timeout, the edge retries 3× with full jitter at exactly one layer (the edge; the fallback does not retry, the client does); consumer idempotency: identity `event_id` and read-time `argMin` |
| 5 Contracts (V) | PASS after work | `ingestRequestSchema`, `ingestResultSchema`, `storedAnalyticsEventSchema` (extended additively), `assignmentsResponseSchema`, `experimentWriteSchema`, `experimentSchema`, `experimentPageSchema`, `experimentHistoryPageSchema`, `experimentResultsSchema`; explicit response mappers; problem+json with stable `code`; `GET`s change no state; V.6 does not apply (no order/payment/booking creation; replay safety is by `event_id` and definition equality); breaking shapes listed in `contracts/` |
| 6 Frontend (VI) | N/A here | no web capability covers experiments; W02/W03 emit events (sibling follow-ups) |
| 7 Tests (VII) | PASS after work | 57 scenarios mapped in `test-plan.md`; each fallback forced (stream down/slow, limiter down, cache down + DB slow, store down/slow); `Promise.all` for AS-31/33/36; real Postgres, ClickHouse, Kafka, Redis; only token verification, the edge credential, time and injected failures are faked; contract schemas parse every body |
| 8 Operations (VIII) | PASS after work | metrics of AS-54; one JSON log line per admin write; logs never carry props values, user ids, tokens or full anonymous ids (≤ 4 chars); the controllers add no liveness/readiness dependency; all timeouts explicit |
| 9 DB isolation (IX) | PASS after work (B5) | `ExperimentAudit` registered `domain:experimentation` in `db/ownership.ts`; ClickHouse tables stay inside the domain; the only other domains reached are `identity` (Firewall, Role) and `orders` (the `OrderPaid` contract, R3); `check:table-ownership --strict` prints no `experimentation` line |
| 10 Monorepo (X) | PASS after work (B4, D-15) | barrel exports `AnalyticsModule`, `AnalyticsProjectorModule`, `ANALYTICS_TOPIC`, `bucketOf` and the policies table only, no repository/model/service; `PurchaseEventsProjector` leaves the barrel (D-8) behind `AnalyticsProjectorModule` (research R-14); S39 adds no domain edge (D-15 unchanged); the shared rules file lives in `packages/contracts` (X.7: used by two runtimes) |

Re-check after design (Phase 1): unchanged, every row still PASS after work. No Complexity Tracking entry is needed.

## Follow-ups from built sibling specs (treated as requirements)

1. **S35 → S39** (`storedAnalyticsEventSchema`): the schema already exists in `packages/contracts/src/analytics/stored-event.ts` (S35 added it), so this plan **extends** it additively instead of creating it: names gain `video_view` and `purchase`; `country`, `platform`, `page` become explicit fields (tolerated extras today); `anonymous_id` stays 8–64 characters except `""` for `purchase` only. The topic key stays `anonymous_id`, and `ts`/`received_at` stay `YYYY-MM-DD HH:mm:ss.SSS` UTC (`STORED_EVENT_TIME` unchanged). Task: an S35 regression run (`trending-contracts.spec.ts`, trending ingest e2e) after the change, and a bullet for S35 in `gaps.md` ("Sibling-spec follow-ups") that `video_view` and `purchase` arrive in the shared enum and `normalise` must ignore names it does not count.
2. **S37 → S39** (`links.events`): "may subscribe", version `1` (not `0`). `questions.md` (accepted) says S39 consumes neither `link.clicked` nor `discussion.post_created`: no requirement of this spec needs them, and a subscription would add a domain edge. Decision recorded in `research.md` R-12: **not subscribed**; the plan keeps the version fact (`link.clicked` v1, origin-only referer) for the day a link-analytics capability is specified, and `gaps.md` states it. No code, no test.
3. **S38 → S39** (assignment and exposure): assign with `bucketOf(salt, unit)` from the domain's own `domain/bucket.ts` (the barrel export stays), salts `"layer:" + layer` and `"exp:" + key` (the S38 note says "experiment id as salt"; the namespaced salt is the `[CONTRACT]` line of `questions.md`, hash values unchanged); flag exposures `name: "exposure"`, `props {flag_key, variant, flag_version}` accepted exactly (AS-26) and never counted in experiment results. `PurchaseEventsProjector` leaves the barrel with S39 (D-8) and its `OrderPaid` import stays S39's edge (D-15, no new edge): see the next paragraph.
4. **S38 D-8 / D-15** (`PurchaseEventsProjector` exit): S39 follows the pattern `apps/projector/src/projector.module.ts` already uses for S36/S29/S30 (`AdsProjectorModule.projectors`, …): a Nest module `AnalyticsProjectorModule` with a static `projectors = [PurchaseEventsProjector]`, exported by the barrel instead of the class. Task T-barrel: add the module, change `apps/projector/src/projector.module.ts:11,115` to `...AnalyticsProjectorModule.projectors` (and add the module to the import list), drop the class export from `index.ts`, run `check:boundaries`.
5. **S50 → S39** (G-35): `experimentation/api/analytics.controller.ts:17-18` used `skipThrottle: true` and `search.query`. The four declared policies replace both (`analytics.ingest` on `POST /events`, `experiments.assignments`, `experiments.admin.write` on `PUT/start/stop`, `experiments.results`), declared in `rate-limit-policies.ts` with `definePolicies('experimentation', …)` and registered by `AnalyticsModule` through `RateLimitModule.forFeature`; the table is exported as `analyticsRatePolicies`. The two tables (`flagsRatePolicies`, `analyticsRatePolicies`) are separate constants with disjoint names. Task: after the change, grep that `search.query` has no S39 call site left (G-35 row for experimentation closed) and that `skipThrottle` no longer appears in the domain (G-34 row closed). The edge worker keeps its existing sliding-window limiter, now applied to `POST /collect` too (research R-9).
6. **Living specification** (rule 0): `docs/spec/capabilities/` has no S39 page. The first implementation task (T001) creates `docs/spec/capabilities/S39-analytics-ab.md` (rules + behaviors with `[proof: S39 AS-nn]` / `[code: …]` anchors, modelled on the S38 page) *before* code changes land, and keeps it true; `python3 scripts/livespec/check.py` must pass. No `*.reviewed.json` is created or edited; nothing signed by a human changes (`gaps.md` "Spec changes" says so).
7. **Unverified criteria** (rule 2): SC-001, SC-004 and SC-006 have no automated test (capacity). They are under "Ops artifacts" in `quickstart.md` and one row each in `specs/UNVERIFIED.md` (added at plan time, status "not run"). SC-002 (10,000-event replay) is proven by a 10,000-event STO test; SC-003 by ASU/STA; SC-005 by AS-24 with the clock; SC-007 by the traceability table and the static gates. AS-57 (one exposure per render) is proven by W02's journey, which does not exist yet: it is stated in `quickstart.md` as not proven by this capability and listed as a sibling follow-up for W02, never as verified.
8. **Sibling-spec follow-ups** are listed in `gaps.md` (W02, W03, S30, S35, S48, S50, J05).
9. **Known failure classes**: L-015/L-004 (boot `apps/core` and `apps/projector` for real after the module changes; if the sandbox denies it, record `blocked` as S36 and S47 did, never claim it verified); L-001 (the topic is standard, no `groupId`; `KafkaProducerService.sendMany` option validation is tested where the message is created); L-002/L-011 (no new queue; the ClickHouse file and the Postgres migration are applied to the test stack; `072` is idempotent, and `check:test-stack`/doctor is compared by hand); L-003 (no "A or B" assertions: every outcome in a test names one expected result, and an environment limit is `blocked`); L-005/L-006 (every e2e creates its own experiments and events with fresh ids and truncates Postgres/ClickHouse in `beforeEach`); L-007 (frozen clock, no real sleeps beyond the topic-to-store wait helper that polls with a deadline); L-008 (six files run as separate processes); L-010 (idempotent creation: `PUT` of an existing key with an equal definition is `200`, a stale one `409`); L-013 (tests that break Kafka, Redis, the cache or ClickHouse restore them in `afterEach`); L-016 (the repair path of the running-set cache catches the cache error it repairs); L-017 (the scenario table in `test-plan.md` is the contract; the scenario id stays in the `it` title when a file is split or renamed).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S39-analytics-ab/
├── plan.md              # this file
├── research.md          # decisions and the gap traceability table
├── data-model.md        # tables, ClickHouse DDL, cache, state machine, query shape
├── contracts/
│   ├── ingest-api.md    # POST /api/events, POST /collect, topic, vectors
│   └── experiments-api.md  # assignments, admin, results, errors, policies, metrics
├── quickstart.md        # runnable validation + ops artifacts
└── tasks.md             # (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/backend/libs/domains/experimentation/
├── api/
│   ├── events.controller.ts                 # POST /events, one call
│   ├── ingest-body.guard.ts / ingest-body.pipe.ts   # 413, 415, text/plain from rawBody
│   ├── experiment-assignments.controller.ts # GET /experiments/assignments
│   ├── experiments-admin.controller.ts      # PUT, start, stop, list, get, history, results
│   ├── experiment-zod.pipe.ts               # shape errors → 400 (flag-zod.pipe.ts pattern)
│   └── ingest-context.ts                    # pure: user (verified), edge-credential country, platform enum
├── application/
│   ├── ingest.service.ts                    # validate each event, enrich, produce, metrics
│   ├── assignment.service.ts                # running set + assign, degraded mode
│   ├── experiment-command.service.ts        # save | start | stop (TransactionRunner)
│   ├── experiment-query.service.ts          # list, get, history
│   ├── experiment-results.service.ts        # store query → domain/results
│   ├── analytics-metrics.ts                 # the AS-54 counters
│   └── (analytics.service.ts deleted; logExposure removed)
├── domain/
│   ├── event-schema.ts                      # wraps contracts rules; ANALYTICS_TOPIC; StoredEvent; no clock
│   ├── experiments.ts                       # assign(), integer weights, bucketOf salts
│   ├── experiment-definition.ts / .spec.ts  # validateDefinition → all {path, code}
│   ├── experiment-lifecycle.ts              # decide(save|start|stop) → noop | apply | error; assertNever
│   ├── experiment-errors.ts                 # ExperimentError(code, status, extra)
│   ├── experiment-cursor.ts                 # opaque keyset cursors
│   ├── results.ts / results.spec.ts         # assemble readout from per-variant counts
│   ├── stats.ts / stats.spec.ts             # + interval, Bonferroni, finite guards
│   └── ports.ts                             # tokens + interfaces (extends the flags ports file)
├── infra/
│   ├── models/experiment.model.ts / experiment-audit.model.ts
│   ├── sequelize-experiment.repository.ts
│   ├── clickhouse-event-store.ts            # results query, dead-letter read helpers for tests
│   ├── kafka-event-producer.ts              # sendMany with 2 s timeout
│   ├── cache-running-set.ts                 # 10 s memory over shared cache, invalidate on write
│   └── purchase-events.projector.ts         # dead letter, injected clock, new table
├── analytics.module.ts · analytics-projector.module.ts
├── rate-limit-policies.ts                   # + analyticsRatePolicies
├── analytics-ingest.e2e-spec.ts · analytics-store.e2e-spec.ts · experiments-assignment.e2e-spec.ts
├── experiments-admin.e2e-spec.ts · experiments-results.e2e-spec.ts · analytics-ops.e2e-spec.ts
└── index.ts

packages/backend/clickhouse/072_analytics_dedupe.sql   # new table, repointed views, backfill
packages/backend/migrations/<next>-experiments-lifecycle.js   # expand only, lock_timeout
packages/backend/db/ownership.ts                       # + ExperimentAudit
packages/contracts/src/analytics/{ingest-rules.ts, ingest-vectors.json, ingest.ts, stored-event.ts (extended)}
packages/contracts/src/experimentation/experiments.ts  # + export in index.ts
packages/edge-be/src/index.ts (collect section)        # imports the shared rules; retry; limiter
packages/edge-be/test/collect.spec.ts
docs/spec/capabilities/S39-analytics-ab.md
```

**Structure Decision**: keep the existing `AnalyticsModule` (controllers + services) and add one projector module; split the one fat `analytics.service.ts` and `analytics.controller.ts` by role (ingest, assignment, admin lifecycle, results), not by endpoint. `apps/core.module.ts` is unchanged (it already imports `AnalyticsModule`); `apps/projector` changes only to import the projector module (task T-barrel). No new deployable app.

## Complexity Tracking

No constitution violation is introduced. Two judgement calls need no exception: (1) the shared rules file in `packages/contracts` is imported by the edge worker through a relative path because the worker is a separate npm project (X.7 placement: code used by two runtimes and containing no domain logic beyond the wire contract); if the worker bundler refuses the import, the fallback is a verbatim copy checked by the shared vector fixture, decided in task T-edge and recorded in `research.md` R-8; (2) the old `analytics_events` table stays one release after the new log table is live (expand/contract, III.11); its removal is a follow-up migration dated two weeks after the first deploy and listed in `quickstart.md`.
