# Implementation Plan: S36 — Sponsored listings (domain `marketing`, ads half)

**Branch**: `S36-sponsored-listings` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-83, FR-001–FR-072, SC-001–SC-010), `test-plan.md`, `gaps.md` (G1–G40, L1–L8, debt D-6/D-7/D-8/D-12), `questions.md` (defaults accepted as written, no line edited by a human), the constitution, and the follow-ups left by S05, S10, S14, S32, S35, S37, S49, S50, S53 and W02 (below).

## Summary

Rebuild the ads half of `marketing` so that a click is billed at most once, nothing is billed that was not served, no shop pays beyond its daily budget, and the shopper always lands on the product:

1. **Campaigns** (`apps/core`): create / list / read / pause / resume / end under `ShopScoped`, `shop.manage` for money-spending actions. Invariants sit in the store (partial unique index per open product, a quota row for the 50-per-shop limit, conditional transitions asserting one row), one `TransactionRunner.run` per command writes the campaign, its history, the product sponsorship and the outbox events together (R-2, R-3).
2. **Read models** (`apps/projector`): `AdProductSnapshot` and `AdShopSnapshot` kept by two version-guarded projectors on `products.events` and `tenancy.events`; archive pauses, delete ends, suspension stops serving; seeded at creation through the R1 batch lookups; staleness ≤ 60 s p99 (R-5).
3. **Serving**: one SQL on marketing tables only, pure ranking (one per shop, CPC then id), spend counters read with a 100 ms timeout (empty list on failure), a signed 30-minute click token with key rotation and domain-separated subkeys (R-6, R-7).
4. **Click**: a service that never throws: verify → marker (`SET NX`) → exact counters (single-key Lua) → pure spam decision → idempotent publish with 1 s timeout (marker removed on failure) → always `302`; address only from the trusted-proxy resolution; HEAD/prefetch never count (R-8).
5. **Counting**: aggregator on the S53 `TransactionalPipeline` with a stable transactional identity, per-message validation with dead-lettering inside the transaction, in-batch dedupe, late-click metric; ClickHouse writers with `ClickHouseSink` dedupe tokens replace the Kafka-engine tables; raw log keeps the first verdict (R-9).
6. **Billing**: hourly run `PENDING → CHARGED` in three separate transactions (marketing, ledger-only, marketing) converging on the ledger reference `ad:<campaign>:<hour>`; whole clicks only; daily reconciliation over the last 3 closed days posts numbered adjustments dated now, never touches closed rows; statement agrees with the ledger (R-10–R-13).
7. **Operate**: dedicated, rotatable secrets with startup validation, metrics of AS-76, log hygiene, graceful shutdown, ownership gates, a load script as ops artifact (R-14–R-19).

Why this shape: the money path is split by transaction owner (IX.4: marketing rows and ledger rows never share a transaction), every step is keyed so that a retry, a crash in either order or a second replica converges, and every correction is a new, dated row so a closed period is never rewritten.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`
**Primary Dependencies**: Sequelize/PostgreSQL (`TransactionRunner`, `@Transactional` — S54), `OutboxService` and `defineEvent` (S53), the S53 projection framework (`Projector`, `TransactionalPipeline`, `ClickHouseSink`), `@app/infrastructure/jobs` (S49 `declareJobType`, `upsertSchedule`, `@JobHandler`), `@app/infrastructure/rate-limit` (`definePolicies`, `@RateLimit`, `@RateLimitExempt`), `RedisService`, `KafkaProducerService`, `ClickHouseService`, `Clock`/`CLOCK`, metrics registry (`@app/common/telemetry`), `LedgerService` (S14, R1), `ProductQueryService` (S05, R1), `ShopQueryService`/`ShopScoped` (S03), `Firewall` (S01), `murmur3` (`@app/common/core`)
**Storage**: PostgreSQL (marketing-owned tables in `data-model.md`), Redis (derived keys, all with TTL), Kafka (`marketing.events`, `ads.clicks`, `ads.click-aggregates`, `ads.clicks.dlq`), ClickHouse (`ad_clicks_log`, `ad_click_minute_v2`)
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (six `ads-*.e2e-spec.ts` files of `test-plan.md`), unit specs U1–U8 beside `domain/` (`pnpm test -- libs/domains/marketing`), k6 script as ops artifact
**Target Platform**: Linux; `apps/core` (HTTP), `apps/worker` (aggregator, writers, jobs), `apps/projector` (read-model consumers)
**Project Type**: backend domain module + contracts package; web owned by W02/W04
**Performance Goals**: redirect p95 ≤ 200 ms (SC-002), 50,000 clicks/s over 64 partitions (SC-008): both are ops artifacts
**Constraints**: dedupe/filter store 100 ms, click publish 1 s, spend-counter read 100 ms, ClickHouse reads 10 s, ledger and database per platform defaults, token life 30 min, marker life 35 min; hours and days UTC; money integer minor units `EUR`
**Scale/Scope**: ≤ 50 open campaigns per shop, ≤ 50 serving candidates per category, 3 slots per response, 10 salted keys per campaign, 3-day reconciliation window, 400-day raw retention

**Maximum read-model staleness accepted (FR-063)**: 60 seconds at the 99th percentile of consumer lag for the product and shop snapshots. A seller's own pause/end acts on the campaign row and is immediate.

**Connection arithmetic (III.12)**: S36 adds no pool; see `research.md` R-19 (worst case 2 connections of `db_pool_max` in `apps/worker`: one per job, both sequential; one per in-flight projector batch in `apps/projector`).

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.4) | PASS after work (D-6, L1, L2) | ports + tokens in `domain/ads-ports.ts`; adapters in `infra/`; `application/` imports no `infra/`; `ADS_CLICKS_TOPIC`/`ClickRecord` move to `domain/`; `domain/` reads no clock (`Date`, `Date.now()` banned; `node:crypto` only) and `check:no-wallclock` loses its two ads exemptions; the click path is five small collaborators, not one 70-line method |
| 2 Pipeline (II) | PASS after work | thin controllers (validated DTO → one service call → DTO); problem+json from the global filter with stable `code`; `ShopScoped(permission)` + `Firewall({anonymous:true})` on the two public routes; record-level authorisation in the predicate (`WHERE id AND "shopId"`) |
| 3 Data access (III) | PASS after work | only marketing `infra/` touches its tables; no network I/O in a transaction (ledger post is its own ledger-only transaction; R1 seeding runs before the command transaction); invariants by constraint/conditional update (III.6/7); keyset cursors; money integer; migrations expand/contract with `lock_timeout`; `statement_timeout` via runner options; both `sequelize.transaction` sites migrated to `TransactionRunner` (`.tx.baseline` 2 → 0) |
| 4 Messaging (IV) | PASS after work | outbox only (IV.4); both projectors validate with zod through the framework, declare `versionGuard`, dead-letter; aggregator validates itself and dead-letters in-transaction; explicit timeouts on every outbound call (FR-072); retries only at the job level |
| 5 Contracts (V) | PASS with one recorded exception | schemas in `contracts/src/marketing/ads.ts`; DTOs only; problem+json; V.5 `GET /ads/click/:token` records a click (Complexity Tracking); V.6 not applicable (no order/payment/booking/bid; the ledger movement is idempotent by reference) |
| 6 Frontend (VI) | N/A here | W02/W04 own screens; obligations on them are in `gaps.md` |
| 7 Tests (VII) | PASS after work | 83 scenarios mapped in `test-plan.md`; fallbacks forced (counters, marker store, publish, aggregator crash/zombie, ledger busy/crash, raw log); concurrency via `Promise.all`; real engines, only edge dependencies faked |
| 8 Operations (VIII) | PASS after work | startup validation of five keys; AS-76 metrics; no secrets/tokens/addresses in logs (AS-79); graceful aggregator shutdown; jobs once per schedule through S49 and idempotent |
| 9 DB isolation (IX) | PASS after work | seven new tables registered `domain:marketing`; two cross-owner FKs dropped; Product and Shop data come from R1 (creation) and R3 (snapshots); zero `marketing` lines in `check:table-ownership --strict` for ads (baseline 1 → 0) |
| 10 Monorepo (X) | PASS after work (D-8, L3) | barrel exports `AdsModule`, `AdsWorkerModule`, `AdsProjectorModule`, DTO types and event definitions only; apps import modules; `ShareLinks*` exports untouched |

Post-design re-check: still PASS. Risks: (a) `ads_aggregator_instance` must be distinct per live replica: a duplicate fences a healthy instance (it stops and readiness fails; documented in `quickstart.md`); (b) replacing the ClickHouse Kafka-engine tables with app-side writers adds two consumers to the worker; the old queue tables must be dropped in the same release or they keep reading `ads.clicks` (`081_ads_v2.sql`); (c) `LedgerModule` is still the only provider of `LedgerService` in S14's barrel, so `AdsWorkerModule` keeps importing it (R1, not a model import).

## Decisions beyond the spec text (so the human can veto)

1. `hour_not_closed` is raised when `now < hourEnd + 5 min` (reconciles FR-040 with AS-56).
2. The product snapshot also stores `priceMinor` and `currency` (needed by the serving response; the spec's list omits them).
3. `ads_aggregator_instance` is a required config key (no default) so transactional identities are stable and distinct.
4. New topic `ads.clicks.dlq` and new ClickHouse tables `ad_clicks_log`, `ad_click_minute_v2`; the old tables stay one release.
5. The spend counter counts clicks (not money); serving compares `(clicks + 1) × cpc` to the budget.
6. A reconciliation run whose source is down is recorded `FAILED` and the job **returns normally** (S49 would otherwise retry what the next schedule retries anyway).
7. Reconciliation race loser is skipped (partial unique index on `RUNNING`), a `RUNNING` row older than 30 min is marked `FAILED/abandoned`.

## Follow-ups from built sibling specs (treated as requirements)

1. **S05**: `ads.service.ts` (`INSERT … SELECT FROM "Product"`, `JOIN "Product"`) is deleted. Ownership/category at creation: `ProductQueryService.getProductsByIds([id], {shopId})` (T30). Serving data: product read model (T36). No `ProductModel` import anywhere in marketing ads.
2. **S10**: S36 reads no `order.*` event (S10 lists S36 as a conversion consumer; not provided, `questions.md`). Nothing to adopt; recorded in `gaps.md`.
3. **S14**: `post`/`balance` are not used; `postJournal` kinds `AD_CHARGE`/`ADJUSTMENT` with the stable references of R-10/R-11 and `getBalances` in tests (T61–T65). `AdBillingRun.journalId` holds the ledger's deterministic journal id (the column is now nullable while `PENDING`). `declareJobType` contracts are tightened and `maxAttempts` set (T66).
4. **S32**: publish `marketing.product_sponsorship_changed v1 {productId, shopId, sponsored, sponsorshipVersion}` through the outbox, only on a change of value (T32); the definition is exported from the barrel.
5. **S35**: nothing shared; the trending case and the `TrendingConsumer`/`TrendingService` imports leave with `ads.e2e-spec.ts`, which is deleted after the six replacement files pass (T98). Until then that file is edited by hand only on those lines if needed to keep the suite compiling.
6. **S37**: the ad click token reads `ads_click_secret` only — no fallback to `share_link_secret`, `share_link_code_key` or `jwt_secret` — and the config rule keeps all of them distinct (AS-77). When ads no longer reads `share_link_secret`: delete it from `types.ts`, `api-config.service.ts`, `OTHER_SECRETS`, line 43 of `notifications-config.ts`, and the exemptions in `scripts/check-no-wallclock.ts` (T08, T93).
7. **S49**: `declareJobType` with strict payload contracts next to the `JobPayloads` augmentation; `upsertSchedule` catching `InvalidScheduleError`; no `JobsService.cancel` (T66); the handlers run through the job registry in AS-50–AS-56 tests, and `AdsWorkerModule` boots in the real `apps/worker` (L-004, L-015).
8. **S50**: policies `marketing.ads-write.shop`, `marketing.ads-read.shop`, `marketing.ads-serve.ip` through `definePolicies` + `forFeature` in `marketing/rate-limit-policies.ts`; structured `RateLimit`/`RateLimit-Policy` headers and `503 rate_limiter_unavailable` adopted in `contracts/ads-api.md` (T26, T34).
9. **S53 (G-44)**: the click aggregator runs on `TransactionalPipeline`; ClickHouse writes go through `ClickHouseSink.insert(…, {dedupeToken})` (T50–T55).
10. **W02**: `GET /ads/sponsored` is now served; the `STOREFRONT_ADS_ENABLED` flag stays off until W02 flips it; the redirect `front/p/<productId>?ad=1` is served by W02's `/p/[productId]` (308, query kept); `sponsored-listing.spec.ts` stays `fixme` (owned by W02). Obligations on W02/W04 are bullets in `gaps.md`.
11. **S54 toolkit (rule 4)**: `TransactionRunner.run` everywhere; both `// S54 T037 audit` sites in `ad-billing.jobs.ts` migrated and their comments deleted; the aggregator's comment disappears with its rewrite; no new direct `sequelize.transaction` (the gate compares to `.tx.baseline` = 2).
12. **gaps.md items**: every row G1–G40 and L1–L8 and debt rows D-6, D-7, D-8, D-12 are in the tasks below (traceability table at the end of `research.md`).
13. **Living specification (rule 0)**: no page exists for S36; the first task writes `docs/spec/capabilities/S36-sponsored-listings.md` (rules and behaviors, `[proof: …]`/`[code: …]` anchors) before code changes, validated by `python3 scripts/livespec/check.py`; no `*.reviewed.json` is created or edited; `gaps.md` "Spec changes" records that nothing signed changes.
14. **Unverified criteria (rule 2)**: SC-002, SC-005 (latency part), SC-007 (alert routing), SC-008 / AS-83, SC-009 (p99 part) and the W02/W04 UI journeys are under "Ops artifacts" in `quickstart.md` and rows in `specs/UNVERIFIED.md` (written at plan time, status "not run").
15. **Sibling follow-ups out** (rule 1): bullets for S32, S14, S37, S50, W02, W04, S10, S03, S05, S54 are in `gaps.md` under "Sibling-spec follow-ups".

## Project Structure

### Documentation

```text
specs/domains/S36-sponsored-listings/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ads-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/marketing/`; contracts in `packages/contracts/src/marketing/`)

```text
packages/contracts/src/marketing/ads.ts                  # + createAdCampaignRequestSchema, adCampaignSchema, adCampaignPageSchema,
                                                         #   adCampaignDetailSchema, adBillingPageSchema, adClickRecordSchema,
                                                         #   minuteAggregateSchema, campaign/sponsorship event payloads, error code list
packages/backend/libs/common/config/{types,api-config.service,config-rules}.ts   # ads_* keys; distinct-secret rule; share_link_secret removed
packages/backend/libs/common/config/notifications-config.ts                       # drop share_link_secret (line 43)
packages/backend/scripts/check-no-wallclock.ts           # remove ads.service.ts / click-token.ts exemptions
packages/backend/migrations/<ts>-ads-campaigns-v2.js     # expand: columns, tables, indexes (lock_timeout)
packages/backend/migrations/<ts>-ads-drop-cross-owner-fks.js
packages/backend/db/ownership.ts                         # + 7 tables domain:marketing
packages/backend/clickhouse/081_ads_v2.sql               # ad_clicks_log, ad_click_minute_v2; drop queue tables + MVs
infra/stack/main.tf                                      # topics marketing.events, ads.clicks (64), ads.click-aggregates, ads.clicks.dlq
packages/backend/scripts/load-tests/ads-clicks.test.js   # + package.json "loadtest:ads-clicks"   (ops artifact)
docs/spec/capabilities/S36-sponsored-listings.md         # living page (first task, re-checked last)
docs/ops/runbooks/AdReconciliationDrift.md               # alert routing (ops artifact)
marketing/
├── api/
│   └── ads.controller.ts                                # campaigns (6 routes), statement, GET /ads/sponsored, GET /ads/click/:token
├── application/
│   ├── campaign-command.service.ts                      # create / pause / resume / end (one TransactionRunner.run each)
│   ├── campaign-query.service.ts                        # list, read (+ billedTodayMinor)
│   ├── billing-statement.service.ts
│   ├── serving.service.ts                               # candidates → counters → selectSlots → tokens
│   ├── click.service.ts                                 # never throws; result union
│   ├── hourly-billing.service.ts  reconciliation.service.ts
│   ├── snapshot-effects.service.ts                      # product/shop events → snapshot upsert + campaign effect, one transaction
│   └── events/ads-events.ts                             # defineEvent × 5
├── domain/
│   ├── ads-ports.ts (+ tokens)  ads-errors.ts  ads-metrics.ts  ads-cursor.ts
│   ├── campaign-state.ts (+ spec)         # U1
│   ├── slot-ranking.ts (+ spec)           # U2
│   ├── click-token.ts (+ spec)            # U3  (rewritten; viewer/ip hashing here)
│   ├── hot-key-salt.ts (+ spec)           # U4
│   ├── spam-filter.ts (+ spec)            # U5
│   ├── click-aggregation.ts (+ spec)      # U6
│   ├── billing-math.ts (+ spec)           # U7
│   └── adjustment-math.ts (+ spec)        # U8
├── infra/
│   ├── models/ad-*.model.ts  sequelize-campaign.store.ts  sequelize-snapshot.stores.ts  sequelize-billing.store.ts
│   ├── redis-impression.marker.ts  redis-spam.counters.ts  redis-spend.counter.ts
│   ├── kafka-click.log.ts                 # publish with 1 s timeout, idempotent producer
│   ├── click-aggregator.service.ts        # TransactionalPipeline spec (rewritten)
│   ├── click-log.writer.ts  aggregate.writer.ts   # consumers → ClickHouseSink with dedupe tokens
│   ├── clickhouse-ad.reader.ts            # exact valid clicks by hour, aggregates by hour (FINAL)
│   ├── ledger.adapter.ts  catalog.adapter.ts  shop-directory.adapter.ts   # R1 behind ports
│   ├── product-snapshot.projector.ts  shop-snapshot.projector.ts          # versionGuard
│   └── ads.jobs.ts                        # declareJobType + schedules + handlers (replaces ad-billing.jobs.ts)
├── rate-limit-policies.ts                 # + 3 ads policies (S37's share-link.create stays)
├── ads.module.ts  ads-worker.module.ts  ads-projector.module.ts  index.ts
├── ads-{campaigns,serving-clicks,aggregation,billing,readmodels,platform}.e2e-spec.ts   # replace ads.e2e-spec.ts
└── testing/ads.fixtures.ts                # frozen clock, fault-injecting wrappers, snapshot/campaign seeding via seed helpers
```

`marketing-contracts.spec.ts` keeps its S36 assertions on the existing slot schemas. Share-link files are not touched (S37) except the shared `rate-limit-policies.ts` (append only) and `index.ts` (ads lines only).

**Structure Decision**: stay inside `marketing` (no new deployable, I.6): three Nest modules matching the three existing processes (`core`, `worker`, `projector`). Splitting the 178-line service into command / query / serving / click services keeps each reviewable, and ports make the Redis/Kafka/ClickHouse/ledger adapters replaceable by the fault-injecting wrappers the tests need.

## Technical tasks by gap (input for `/speckit-tasks`)

Order is test-first within each step; the whole capability suite runs once at the end in batches of fresh processes (L-008). Backend commands from `packages/backend`; specs through `scripts/sdd/test-spec.sh`. After 5 failed fixes of the same test: stop and write the blocker in `questions.md`.

1. **Contracts, living page, baselines (T01–T03)**: T01 `docs/spec/capabilities/S36-sponsored-listings.md` first (rule 0) and `python3 scripts/livespec/check.py`; T02 `contracts/src/marketing/ads.ts` schemas and error codes, additive to the existing slot schemas (G2, G9, G17); T03 run `check:table-ownership`, count direct `sequelize.transaction` in marketing, run `marketing-contracts.spec.ts`, boot the real `core` and `worker` once to know the starting state (L-004, L-015; reconcile `gaps.md` §3 with the real output).
2. **Schema, config, topics (T04–T09)**: T04 expand migration (columns, seven tables, indexes, backfill; G4, G38); T05 drop cross-owner FKs in their own step (L7); T06 `db/ownership.ts` + model registry (L7, AS-80); T07 `081_ads_v2.sql` (G25, G39); T08 config keys, distinctness rule, `share_link_secret` removal, `front_host` use (G11, G34, G36, AS-77; S37 follow-up); T09 Terraform topics and the test stack's topic list (L-011, L-002: every topic the code names exists in the stack; readiness/doctor check).
3. **Pure logic with unit specs (T10–T18)**: T10 click token (G11, AS-24, AS-25); T11 slot ranking (AS-23); T12 campaign state (AS-15); T13 spam decision + hot-key salt (G16, G18, AS-37, AS-41); T14 batch aggregation (G21, AS-42); T15 billing math (G26, AS-57); T16 adjustment math (AS-67); T17 cursor helper; T18 metrics module (AS-76). `fast-check` with fixed seeds for AS-23, AS-24, AS-42, AS-57, AS-67. `domain/` has no `Date`.
4. **Ports and adapters (T20–T27)**: T20 ports + tokens (L1); T21 models and stores (campaign, snapshots, billing; conditional updates; D-12); T22 Redis marker, counters (single-key Lua, TTL only on first write — G16), spend counter; T23 click log publisher with timeout (G12, G13); T24 ClickHouse reader (`FINAL`, `GROUP BY click_id`) and sink writers; T25 R1 adapters (ledger, catalog, shop directory; D-7); T26 rate-limit policies (G6); T27 module wiring and test fixtures (L-015).
5. **Campaign API (T30–T35)**: T30 create with R1 seed and typed errors (G2, G3); T31 pause/resume/end state machine with history (G1); T32 outbox events and sponsorship signal (G32); T33 list/read/`billedTodayMinor` (G1, G31); T34 controller, roles `shop.manage`/`products.read`, rate limits, problem codes (G5, G37); T35 `ads-campaigns.e2e-spec.ts` (AS-01–AS-14).
6. **Read models (T36–T39)**: T36 product and shop projectors with effects (G33); T37 resume guards (AS-72); T38 `ads-readmodels.e2e-spec.ts` (AS-70–AS-75); T39 `AdsProjectorModule` in the real `apps/projector` (L-004).
7. **Serving and click (T40–T49)**: T40 serving service (G7–G10, G19); T41 token minting and viewer hash (G9, G11); T42 click service (G12, G13, G15, G17); T43 trusted address (G14); T44 redirect target from `front_host` only (G36); T45 spam filter wiring (G16); T46 degradation paths (AS-21, AS-34, AS-35); T47 controller + `RateLimitExempt`; T48 `ads-serving-clicks.e2e-spec.ts` (AS-16–AS-40); T49 key rotation test (AS-25).
8. **Aggregation (T50–T58)**: T50 `TransactionalPipeline` aggregator with stable id (G20); T51 validation + in-transaction dead letters (G21); T52 `fromBeginning` and start-up failure fails the start (G22, G23); T53 late clicks (G24); T54 log and aggregate writers with dedupe tokens (G25, S53 G-44); T55 graceful shutdown (AS-82); T56 `ads-aggregation.e2e-spec.ts` (AS-43–AS-49); T57 crash and zombie injection; T58 topic partition count for the salted key test (G39).
9. **Billing and statement (T60–T72)**: T60 run states and unique reference; T61 hourly service (G26–G28, AS-50–AS-56); T62 ledger posting in its own transaction (G27, L4, L5); T63 reconciliation (G29, G30, AS-58–AS-66); T64 adjustments and period close (AS-62); T65 drift metric and warning (AS-65); T66 jobs: `declareJobType` contracts, `maxAttempts`, schedules, handlers (S49 follow-up; replaces `ad-billing.jobs.ts`, both `// S54 T037 audit` sites gone); T67 `ads-billing.e2e-spec.ts` (AS-50–AS-69); T68 orphan and ended campaigns (AS-55); T70 statement service + keyset (G31); T71 statement/ledger equality (AS-69); T72 role and tenant cases (AS-68).
10. **Platform (T90–T94)**: T90 metrics scrape test (AS-76); T91 config boot failures (AS-77); T92 problem+json audit and generic 5xx (AS-78); T93 log hygiene scan and `check-no-wallclock` exemptions removed (AS-79, G35); T94 migrations up/down/up and ownership gates (AS-80, AS-81); `ads-platform.e2e-spec.ts`.
11. **Operations artifacts (T96)**: `scripts/load-tests/ads-clicks.test.js` + `loadtest:ads-clicks` (G40), `docs/ops/runbooks/AdReconciliationDrift.md`.
12. **Barrel, wiring, cleanup (T97–T99)**: T97 `index.ts` (modules, DTO types, event definitions), `apps/core`, `apps/worker`, `apps/projector` import modules (L3, D-8); T98 delete `application/ads.service.ts`, `infra/ad-billing.jobs.ts`, `ads.e2e-spec.ts` only after the replacements pass (L6, D-7 test side); T99 gates: `tsc --noEmit` and ESLint (backend, contracts), `check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict` (zero ads lines), `check:no-wallclock`, `python3 scripts/livespec/check.py`, the whole capability suite once, `scripts/qa/fresh-run.sh` (L-012), start the real API, worker and projector (L-004).

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| V.5: `GET /ads/click/:token` records a click | The notes' design is a redirect click service; clients that block scripts still click links. Safe because the impression is idempotent (marker), the response is `no-store`, `HEAD` and prefetch do not count, and the spam filter decides billability | A `POST` beacon loses clicks from clients without scripts and is not what the notes describe (`questions.md` BREAKING) |
| Three separate transactions in one charge (marketing / ledger-only / marketing) | IX.4 forbids one transaction writing two owners; the ledger reference makes the steps converge after a crash in either order | One transaction writing `AdBillingRun` and the ledger tables is gap G27 |
| `LedgerModule` still imported into `AdsWorkerModule` | S14's barrel exports `LedgerService` only through `LedgerModule` (R1 export of a service, no model) | A narrower port does not exist yet; adding one is S14's change (sibling bullet) |
| Two ClickHouse writers replace the Kafka-engine tables | `ClickHouseSink` dedupe tokens (S53 G-44) and testable `read_committed` consumption; the engine's setting lived in server config (Q58) | Keeping the engine tables leaves exactly-once reading untestable and cannot add the new columns safely |
