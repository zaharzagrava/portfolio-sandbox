# Implementation Plan: S41 — Competitor Price Monitor (domain `seller-insights`)

**Branch**: `S41-competitor-monitor` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (57 scenarios, FR-001–FR-035, SC-001–SC-008), `test-plan.md`, `gaps.md` (A1–A34, B, C, D), `questions.md` (defaults accepted), constitution v3.1.0, and the follow-ups listed under "Follow-ups from built specs" below.

## Summary

Rebuild the existing single-file crawler (`crawler.module.ts` + `application/crawler.service.ts`, 378 lines) into the layered shape of I.1: a core `CompetitorsModule` (four routes), a worker `CrawlerWorkerModule` (scheduler, fetch loops, purge) and a projector module (shop read model, product cleanup). Behaviour moves from "one target-level comparison, direct SQL on foreign tables" to "per-watch evaluation, one outbox event per owner, R1/R3 access only".

State of the tree on 2026-10-17 (read, not assumed; several `gaps.md` rows were already closed by other specs and are marked in [research.md](research.md) §Gap status):

- Done by siblings, to keep and test: `safeGet`/`SafeRequestError` with injectable resolver, deadline, redirect policy (S54, `libs/infrastructure/net`); product read through `ProductQueryService.getProductsByIds` and owners through `MembershipQueryService.getMembersByShopIds` (R1); alert through `OutboxService.appendStandalone` as `sellerinsights.competitor_price_dropped` v1 (S28); `declareJobType('crawler.schedule-due')` (S49).
- Still open: everything else in `gaps.md` section A (A1–A8, A10–A22, A24–A34), the table-ownership rows of section C (FKs to `Shop`/`Product`, test-side `ShopModel`/`ShopMembershipModel`), contracts, migrations, tests.

Technical approach, in order of dependency:

1. **Pure domain first** (`domain/`): rewrite `url.ts`, `robots.ts`, `extract-price.ts`, `simhash.ts`; add `schedule.ts` (interval ladder, jitter, status mapping), `alert-rule.ts` (the per-watch condition of FR-025), `ports.ts` (repositories and adapters as tokens). Table-driven + fast-check unit specs.
2. **Schema**: one expand migration (drops the two FKs, adds watch/target columns, `CompetitorShop` read model, re-normalise + merge targets), one ClickHouse migration (`observation_no`, insert dedup token). Registry entry in `db/ownership.ts`.
3. **Contracts** in `packages/contracts/src/seller-insights/` (request/response schemas, problem codes, consumed-event schemas, the event schema).
4. **Infra adapters**: Sequelize repositories, Redis frontier/lease/robots-cache/seen-set/queue marks, ClickHouse history, object-storage archive, `SafeFetcher` over `safeGet`.
5. **Application**: `WatchService` (register/list/remove/history, evaluate-on-register), `CrawlService` (one crawl: robots → fetch → extract → observe → evaluate), `SchedulerService`, `EvaluationService` (batches of 500, outbox in the same transaction), `RetentionService`, `ShopReadModelService`, `CrawlerMetrics`, `CrawlerConfig`.
6. **API + modules + wiring**: controller in `api/` using contracts schemas, rate-limit policy `seller-insights.competitor-write.shop`, three Nest modules, barrel exports, apps wiring (core, worker, projector), job `crawler.purge-targets`.
7. **Tests**: five e2e files + four unit specs from `test-plan.md`; replace `crawler.e2e-spec.ts` and `domain/crawler.spec.ts`.
8. **Living spec page** `docs/spec/capabilities/S41-competitor-monitor.md` (none exists today): written before code per cross-spec rule 0, kept true by `python3 scripts/livespec/check.py`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS, Sequelize (+sequelize-typescript), zod, `fast-check` for properties.

**Primary Dependencies**: `@app/infrastructure/{net,outbox,events,projections,jobs,rate-limit,redis,clickhouse,storage,context,platform}`, `@app/domains/{catalog,tenancy,billing,identity}` entry points (R1 only), `@marketplace-sandbox/contracts`.

**Storage**: Postgres (`CompetitorWatch`, `CrawlTarget`, new `CompetitorShop`); Redis (frontier, host lease, queue marks, robots cache, Bloom seen-set — derived, rebuildable); ClickHouse `competitor_prices` (history); object storage (archive, 7-day lifecycle).

**Testing**: jest e2e through `scripts/sdd/test-spec.sh` (real Postgres/Redis/ClickHouse/MinIO/Kafka stand-in, frozen clock `T0`), unit `it.each` + fast-check for pure code.

**Target Platform**: Linux containers; apps `core` (routes), `worker` (scheduler, fetch loops, purge), `projector` (consumers). No new deployable app (I.6).

**Project Type**: backend domain module in a monorepo (web screen is out of scope).

**Performance Goals**: registration p95 < 500 ms excl. DNS, history read p95 < 300 ms (SC-006); design target 460 fetches/s fleet-wide (SC-007, load script, not CI).

**Constraints**: one in-flight request per host fleet-wide; request 10 s, crawl 30 s, body 2 MiB, 3 same-host https redirects; no network I/O inside a DB transaction (III.3).

**Scale/Scope**: 10 M watched URLs at 6 h; per-run scheduler cap 5000; evaluation batches of 500.

**Connection arithmetic (III.12)**: no new pool. Worker fetch loops (default 16, max 64) hold no DB connection while fetching (the target row is read, the connection released, the fetch runs, then one short transaction records the result). Peak DB connections per worker instance from this capability = loops that are in the "record" step at once, bounded by the existing pool (unchanged) — loops wait for a pool slot, they do not open more.

## Constitution Check

| Rule | Status | How the design satisfies it |
|---|---|---|
| I.1–I.3 layers, ports | PASS (fixes D-6) | `api/competitors.controller.ts` + contracts; `application/*` reaches stores only through `domain/ports.ts` tokens; `domain/` pure, clock injected (`now` parameter) |
| I.4 ownership | PASS | `CompetitorWatch`, `CrawlTarget`, `CompetitorShop` owned by `seller-insights`; Redis prefix `crawl:`; topic produced `seller_insights.events` |
| I.6 new app | PASS | none |
| II.1 controller thin | PASS | one service call per route; errors are typed domain errors mapped by the global filter |
| III.2/III.3 transactions, no I/O inside | PASS | `TransactionRunner.run`/`@Transactional`; fetch, ClickHouse insert, archive happen outside the transaction. History row is written **before** the state transaction (idempotent on `(target_id, observation_no)`), archive after commit |
| III.4 tenant predicate | PASS | every watch lookup `WHERE id = :id AND "shopId" = :shopId`; list scoped by shop |
| III.5 SQL | PASS | parameterised; no dynamic identifiers |
| III.6 invariants in store | PASS | watch limit serialised per shop with `pg_advisory_xact_lock(hash(shopId))` inside the registration transaction; unique `(productId, targetId)`; unique normalised `CrawlTarget.url`; observation step is `UPDATE … WHERE observationNo = :read` |
| III.8 money | PASS | integer minor units, decimal-string arithmetic with the ISO 4217 exponent, `BIGINT` |
| III.9 caches | PASS | Redis state is derived; every key has TTL; `SCAN`, never `KEYS` (the old test's `redis.keys('crawl:*')` is replaced) |
| III.10 cursor | PASS | `(createdAt DESC, id DESC)` keyset, opaque cursor |
| III.11 migrations | PASS | expand only, `lock_timeout`; FK drop is a contract of a constraint nobody reads |
| IV.1 / IX.4 / IX.7 | PASS | R1 `getProductsByIds(ids,{shopId})`, `getMembersByShopIds(ids,['OWNER'])`, billing `EntitlementsService`; R3 `CompetitorShop` + `catalog.product_deleted`; no join/FK to foreign tables; `index.ts` exports modules only |
| IV.3/IV.4 | PASS | alert is an outbox event inside the evaluation transaction (`OutboxService.append`, IX.6) |
| IV.5 consumers | PASS | shop consumer: version-guarded upsert; product consumer: idempotent delete; both zod-validated, DLQ with reason (S53 framework) |
| IV.6 timeouts | PASS | `safeGet` deadline 10 s; crawl budget 30 s (< lease 60 s); redis/ClickHouse/storage calls carry timeouts; retries only through the re-crawl ladder (one layer) |
| IV.8 ACL | PASS | competitor pages are untrusted: `SafeFetcher` port, extraction validates every number |
| V.1–V.4 | PASS | response DTOs from contracts; problem+json via global filter; 404 for foreign shop/watch/product |
| V.6 idempotency key | N/A | registration is naturally idempotent (200 replay by (product, normalised URL)); it creates no order/payment/booking/bid/ledger entry |
| VII.2–VII.9 | PASS | test-plan.md: 5 e2e files, 4 unit specs, one row per AS; no foreign models injected (fixtures + exported services); fault tests for each degradation path |
| VIII.1 logs | PASS | `targetId`, `host`, `crawlId`; never URL, query, body, resolved address |
| VIII.5 config | PASS | `CrawlerConfig` zod-validated at start (AS-56) |
| VIII.6 jobs | PASS | `crawler.schedule-due` (concurrency 1) and new `crawler.purge-targets` through S49, `declareJobType` for both |
| IX.3 registry | PASS | `CompetitorShop` added to `db/ownership.ts` in the migration's task |
| S54 T037 | PASS | the one direct `sequelize.transaction` left in this domain (if the audit finds one in the files touched) is migrated to `TransactionRunner.run` and its `// S54 T037 audit` comment deleted; none added |

No violations; the Complexity Tracking table is empty.

**Post-design re-check**: unchanged after Phase 1 (the only judgement call, a per-shop advisory lock for the limit, is the III.6 "row lock" option and is documented in research.md D-04).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S41-competitor-monitor/
├── spec.md · test-plan.md · gaps.md · questions.md   # inputs
├── plan.md            # this file
├── research.md        # decisions, gap status, follow-ups
├── data-model.md      # tables, columns, state machines, Redis keys, ClickHouse
├── contracts/
│   ├── api.md         # four routes, schemas, error codes
│   └── events.md      # produced + consumed events
├── quickstart.md      # run guide + Ops artifacts
└── tasks.md           # /speckit-tasks (not created here)
```

### Source Code

```text
packages/backend/libs/domains/seller-insights/
├── api/
│   ├── competitors.controller.ts         # 4 routes (core)
│   └── rate-limit-policies.ts            # + seller-insights.competitor-write.shop
├── application/
│   ├── competitor-watch.service.ts       # register, list, remove, history
│   ├── competitor-evaluation.service.ts  # per-watch alert rule, batches of 500, outbox
│   ├── crawl.service.ts                  # one target crawl (replaces crawler.service.ts)
│   ├── crawl-scheduler.service.ts        # schedule-due, priority, queue marks
│   ├── crawl-retention.service.ts        # purge-targets
│   ├── competitor-shop.service.ts        # read-model apply (version guard)
│   ├── crawler.config.ts · crawler.metrics.ts
│   └── events/seller-insights-events.ts  # + priceVersion
├── domain/
│   ├── url.ts · robots.ts · extract-price.ts · simhash.ts      # rewritten (pure)
│   ├── schedule.ts                       # ladder, jitter, status mapping
│   ├── alert-rule.ts                     # FR-025 condition
│   ├── competitor-errors.ts              # url_not_allowed … (typed)
│   └── crawler-ports.ts                  # WatchRepository, TargetRepository, ObservationHistory,
│                                         # PageArchive, RobotsCache, FrontierPort, SeenSet, SafeFetcher
├── infra/
│   ├── pg-watch.repository.ts · pg-target.repository.ts · pg-competitor-shop.repository.ts
│   ├── models/competitor-watch.model.ts · crawl-target.model.ts · competitor-shop.model.ts
│   ├── redis-frontier.ts (from frontier.ts, `{shard}` tags) · redis-robots-cache.ts · redis-seen-set.ts
│   ├── clickhouse-observation-history.ts · s3-page-archive.ts · safe-fetcher.ts
│   └── projectors/competitor-shop.projector.ts · competitor-product.projector.ts
├── competitors.module.ts                 # core
├── crawler-worker.module.ts              # worker (replaces crawler.module.ts)
├── competitor-projector.module.ts        # projector
├── testing/competitor-fixtures.ts        # fixture server, resolver double, fault switches
└── *.e2e-spec.ts × 5 (names in test-plan.md)
packages/backend/migrations/<ts>-competitor-s41-expand.js
packages/backend/clickhouse/09x_competitor_prices_v2.sql
packages/backend/db/ownership.ts                       # + CompetitorShop
packages/backend/scripts/load-tests/competitor-crawl.* # SC-007
packages/contracts/src/seller-insights/competitors.ts  # schemas
docs/spec/capabilities/S41-competitor-monitor.md       # living spec page
```

**Structure Decision**: extend the existing `seller-insights` domain (no new app, no new lib). `crawler.module.ts` and `application/crawler.service.ts` are deleted once their content is split; `index.ts` exports `CompetitorsModule`, `CrawlerWorkerModule`, `CompetitorProjectorModule` (D-8).

## Follow-ups from built specs (each is a requirement of this plan)

| From | Requirement | Where planned |
|---|---|---|
| S03 | no `ShopModel`/`ShopMembershipModel`/raw tenancy SQL; `MembershipQueryService` for owners; retest `403 shop_suspended` / `409 shop_offboarding` on closed shops and VIEWER-vs-`products.write` | research D-07; AS-07 test adds an offboarding-shop write → `409 shop_offboarding`; e2e fixtures use shared helpers (D-7) |
| S05 | `getProductsByIds(ids,{shopId?})` one batch per page/evaluation batch, no `JOIN "Product"`/`ProductModel` | `competitor-watch.service.ts`, `competitor-evaluation.service.ts`; FK to `Product` dropped |
| S28 | event name and shape: keep emitted `sellerinsights.competitor_price_dropped` v1 (S53 envelope forbids `_` in the first segment); add `priceVersion`; topic `seller_insights.events`; `crawler.e2e-spec.ts` assertion is carried into `competitor-alerts.e2e-spec.ts` | contracts/events.md; spec text to be aligned via the living page (Spec changes in gaps.md) |
| S49 | `declareJobType` with payload contract for `crawler.schedule-due` (exists) and `crawler.purge-targets` (new); catch `InvalidScheduleError` on `upsertSchedule` at boot (log, fail start) | worker module task |
| S54 | adopt the SSRF vocabulary from `@app/infrastructure/net` (`SafeRequestErrorKind`) as the crawler's status vocabulary: `blocked_address`, `unresolvable`, `invalid_url`, `redirect_refused`, `redirected_host`, `too_many_redirects`, `unsupported_content_type`, `timeout`, `tls_error`, `network_error`; registration maps `invalid_url`/`blocked_address` → `422 url_not_allowed`, `unresolvable` → `422 url_unresolvable` | research D-02, `safe-fetcher.ts`, `domain/schedule.ts` status table |
| S54 T037 | no new direct `sequelize.transaction`; migrate any in touched files | constitution check row |

## Complexity Tracking

None.
