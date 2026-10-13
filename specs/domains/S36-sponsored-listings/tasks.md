# Tasks: S36 — Sponsored listings (domain `marketing`, ads half)

**Input**: `plan.md`, `spec.md` (US1–US10, AS-01–AS-83), `test-plan.md`, `gaps.md` (G1–G40, L1–L8, D-6/D-7/D-8/D-12), `data-model.md`, `contracts/ads-api.md`, `contracts/events.md`, `research.md` (R-n), `questions.md` (defaults accepted).
**Tests**: required (test-plan.md). Every e2e/unit test task comes **before** the code task that makes it pass; confirm it fails first (L-003: a test must be able to fail).
**Paths**: `MKT` = `packages/backend/libs/domains/marketing`, `CON` = `packages/contracts/src/marketing`. Backend commands run from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <file>`; units through `pnpm test -- <path>`. Same test failing after 5 fix attempts → write blocker, attempts and hypothesis in `questions.md` and stop.
**Standing rules**: no git checkout/restore/reset/stash/clean (undo by hand); never create or edit `*.reviewed.json`; `TransactionRunner.run`/`@Transactional` only, no new `sequelize.transaction`; do not edit sibling specs (use gaps.md "Sibling-spec follow-ups"); `domain/` reads no clock; run big suites in batches of fresh processes (L-008).

## Phase 1: Setup

- [X] T001 Write the living page `docs/spec/capabilities/S36-sponsored-listings.md` (rules and behaviors for US1–US10, `[proof: …]` pointing at the e2e/unit files of test-plan.md, `[code: …]` anchors on MKT files) BEFORE any code; run `python3 scripts/livespec/check.py` and keep it green at each later phase; do not create/edit any `*.reviewed.json`
- [X] T002 Record the starting state in `specs/domains/S36-sponsored-listings/gaps.md` §3: run `pnpm check:table-ownership` (marketing lines), `grep -rn "sequelize.transaction" MKT | grep -v share-link` (expect 2), `marketing-contracts.spec.ts`, and boot real `apps/core` and `apps/worker` once (L-004, L-015); reconcile gaps.md §3 with the real output
- [X] T003 [P] Add schemas to `CON/ads.ts` (additive to existing slot schemas; G2, G9, G17): `createAdCampaignRequestSchema` (strict; `cpcMinor` int 1–10000; `dailyBudgetMinor` int 100–10000000 and ≥ `cpcMinor`; `productId` uuid), `adCampaignSchema`, `adCampaignPageSchema`, `adCampaignDetailSchema` (+`billedTodayMinor`), `adBillingPageSchema`, `adClickRecordSchema` (snake_case, with `product_id`, `viewer_hash`, `invalid_reason`), `minuteAggregateSchema`, campaign/sponsorship event payloads (events.md), error-code list; sponsored query `category` `^[a-z0-9-]{1,40}$` or `all`, `limit` int 1–3; lists `limit` int 1–100; statement range ≤ 92 days and `from < to`; export from the contracts barrel
- [X] T004 [P] Create `MKT/testing/ads.fixtures.ts`: frozen clock helper, fault-injecting wrappers (Redis, Kafka producer, ClickHouse client, ledger first call), snapshot/campaign seeding through the shared seed helpers, `clean()` + ads keyspace flush + analytics truncate, fresh consumer group id (test-plan.md conventions)

## Phase 2: Foundational (blocks all stories)

- [X] T005 Expand migration `packages/backend/migrations/<ts>-ads-campaigns-v2.js` (`lock_timeout`, `IF NOT EXISTS`; G4, G38): `AdCampaign` + `cpcMinor` `CHECK 1..10000`, `dailyBudgetMinor` `CHECK 100..10000000 AND >= cpcMinor`, `currency` `CHECK = 'EUR'`, `status` `CHECK IN ('ACTIVE','PAUSED','ENDED')`, `statusReason` `'seller'|'product_unavailable'` nullable, `campaignVersion` starts 1, `updatedAt`; backfill from `cpcCents`/`dailyBudgetCents`; indexes `AdCampaign_open_product_uq UNIQUE("productId") WHERE status <> 'ENDED'`, `AdCampaign_shop_list_idx`, `AdCampaign_serve_idx`; tables `AdCampaignHistory` (`UNIQUE(campaignId,campaignVersion)`), `AdProductSponsorship`, `AdShopQuota` (`openCount CHECK BETWEEN 0 AND 50`), `AdProductSnapshot`, `AdShopSnapshot`, `AdBillingAdjustment` (`deltaMinor` ≠ 0, `ledgerReference UNIQUE`, PK `(campaignId,hour,sequence)`), `AdReconciliationRun` (`UNIQUE(day) WHERE status='RUNNING'`); `AdBillingRun` + `state` (`PENDING|CHARGED`, existing→`CHARGED`), `source` (`stream|reconciliation`), `billableClicks`, `cappedClicks`, `amountMinor` bigint, `ledgerReference UNIQUE`, `chargedAt`, `journalId` nullable, `CHECK (state='CHARGED' OR amountMinor>=0)`
- [X] T006 Own-step migration `packages/backend/migrations/<ts>-ads-drop-cross-owner-fks.js`: drop FKs `AdCampaign.shopId`→Shop and `productId`→Product (L7, IX.4); keep internal FKs
- [X] T007 [P] Register the seven new tables as `domain:marketing` in `packages/backend/db/ownership.ts` and the model registry (L7, AS-80)
- [X] T008 [P] ClickHouse `packages/backend/clickhouse/081_ads_v2.sql` (own step; G25, G39): `ad_clicks_log` (MergeTree, `PARTITION BY toYYYYMMDD(received_at)`, `ORDER BY (toStartOfHour(received_at), campaign_id, click_id)`, `TTL received_at + 400 DAY`, first verdict kept) and `ad_click_minute_v2` (ReplacingMergeTree, `ORDER BY (campaign_id, minute, source_partition, first_offset)`); drop `ad_clicks_queue`, `ad_clicks_raw_mv`, `ad_click_aggregates_queue`, `ad_click_minute_mv`
- [X] T009 [P] Terraform `infra/stack/main.tf` + the test stack topic list: `marketing.events`, `ads.clicks` (64 prod / 10 test), `ads.click-aggregates`, `ads.clicks.dlq`; make the doctor/readiness fail while a named topic is missing (L-002, L-011, G39)
- [X] T010 Config in `packages/backend/libs/common/config/{types,api-config.service,config-rules}.ts` (G11, G34, G36; S37 follow-up; AS-77): keys `ads_click_secret` (≥ 32 bytes), `ads_click_secret_previous` (optional), `ads_spam_ip_per_minute` (20), repeat thresholds, `ads_aggregator_instance` (required, no default), `front_host` must be an origin; rule keeping `ads_click_secret`, previous, `jwt_secret`, `share_link_code_key` pairwise distinct; no fallback to `share_link_secret`; startup fails naming the key
- [X] T011 [P] Pure domain unit specs (write first, see them fail) in `MKT/domain/`: `campaign-state.spec.ts` U1 (AS-15, 3×3 `it.each`), `slot-ranking.spec.ts` U2 (AS-23 + fast-check fixed seed), `click-token.spec.ts` U3 (AS-24: valid, expiry edge, tamper, shape, wrong secret, never throws + property), `hot-key-salt.spec.ts` U4 (AS-37: determinism, range 0..9, distribution over 10,000 fixed IDs), `spam-filter.spec.ts` U5 (AS-41 precedence, monotonic), `click-aggregation.spec.ts` U6 (AS-42 order independence, conservation), `billing-math.spec.ts` U7 (AS-57), `adjustment-math.spec.ts` U8 (AS-67)
- [X] T012 [P] Implement `MKT/domain/campaign-state.ts`, `slot-ranking.ts` (one per shop, CPC desc then id), `hot-key-salt.ts` (murmur3 of click id, no `Math.random`), `spam-filter.ts` (pure decision), `click-aggregation.ts` (in-batch dedupe, minute by clock, late detection) so U1, U2, U4, U5, U6 pass
- [X] T013 [P] Rewrite `MKT/domain/click-token.ts` (G11): key ID header, current + previous key, domain-separated subkey, full-length signature, zod-validated claims `{i,c,s,p,e,v}`, 30-min life, viewer/ip hashing, never throws; U3 passes
- [X] T014 [P] Implement `MKT/domain/billing-math.ts` (whole clicks only, `min(clicks, floor(remaining/cpc))`, integers) and `adjustment-math.ts` (net delta to exact, budget cap on recomputation); U7, U8 pass
- [X] T015 [P] Create `MKT/domain/ads-ports.ts` (+ injection tokens), `ads-errors.ts` (stable problem codes), `ads-cursor.ts` (keyset), `ads-metrics.ts` (AS-76 names/labels, no high-cardinality labels); move `ADS_CLICKS_TOPIC` and `ClickRecord` into `domain/` (L1)
- [X] T016 Models + stores in `MKT/infra/`: `models/ad-*.model.ts`, `sequelize-campaign.store.ts` (conditional transitions asserting one row, quota upsert `WHERE openCount < 50`, D-12), `sequelize-snapshot.stores.ts` (version-guarded upsert `WHERE productVersion < incoming`, delete → `DELETED`), `sequelize-billing.store.ts`
- [X] T017 [P] R1 adapters behind ports (D-7, D-12): `MKT/infra/ledger.adapter.ts` (`postJournal` `AD_CHARGE`/`ADJUSTMENT`, `getBalances`, `shopAccount`, `LEDGER_ACCOUNTS`), `catalog.adapter.ts` (`getProductsByIds([id],{shopId})`), `shop-directory.adapter.ts` (`getShopsByIds`)
- [X] T018 [P] Redis adapters in `MKT/infra/`: `redis-impression.marker.ts` (`SET NX`, TTL 2,100 s, removable), `redis-spam.counters.ts` (single-key Lua, TTL only on first write; G16), `redis-spend.counter.ts` (`adspend:{campaignId}:YYYY-MM-DD`, 100 ms timeout); explicit timeouts everywhere (FR-072)
- [X] T019 [P] `MKT/infra/kafka-click.log.ts` (idempotent producer, 1 s timeout; G12, G13) and `MKT/infra/clickhouse-ad.reader.ts` (exact valid clicks by hour with `GROUP BY click_id`, aggregates with `FINAL`, 10 s timeout)
- [X] T020 [P] Append three policies to `MKT/rate-limit-policies.ts` via `definePolicies` + `forFeature`: `marketing.ads-write.shop` 60/min closed, `marketing.ads-read.shop` 300/min open, `marketing.ads-serve.ip` 120/min open (G6; S37's policy untouched); adopt `RateLimit`/`RateLimit-Policy` headers, `503 rate_limiter_unavailable`, `422 rate_limit_cost_exceeded` in the controller and in `contracts/ads-api.md`
- [X] T021 Module skeletons `MKT/ads.module.ts`, `ads-worker.module.ts`, `ads-projector.module.ts` providing ports → adapters; `MKT/application/events/ads-events.ts` with five `defineEvent` (campaign_created/paused/resumed/ended + `marketing.product_sponsorship_changed` v1 `{productId, shopId, sponsored, sponsorshipVersion}`); `tsc --noEmit` passes

**Checkpoint**: units U1–U8 green, migrations apply, `tsc` clean, real `apps/core` boots (L-015).

## Phase 3: US1 — A shop sponsors a product and controls the campaign (P1) 🎯 MVP

**Goal**: create/list/read/pause/resume/end campaigns with invariants in the store. **Independent test**: `ads-campaigns.e2e-spec.ts` (AS-01–AS-14; AS-15 via U1).

- [X] T022 [US1] Write `MKT/ads-campaigns.e2e-spec.ts` (`Sponsored listings: campaigns`; real modules, global pipe/filter, supertest; parse bodies with contract schemas): AS-01 create (rows, history, `campaign_created` + sponsorship v1 in outbox), AS-02 each validation class `400`/`422 budget_below_cpc`, AS-03 `401`/`403` for VA/SA/statement, success AA/OA, AS-04 cross-tenant `404`, AS-05 archived/sandbox/unknown/out-of-stock, AS-06 `409` + re-create after end + race, AS-07 51st `422` + race at 49, AS-08 pause/resume/end, AS-09 illegal pairs `409`, AS-10 concurrent `Promise.all`, AS-11 no sponsorship event when value unchanged, AS-12 keyset/filter/invalid limit/status/cursor, AS-13 detail `billedTodayMinor` from posted charges, AS-14 `429` + `Retry-After`, limiter down `503`; must fail now
- [X] T023 [US1] `MKT/application/campaign-command.service.ts` create (G2, G3): R1 `getProductsByIds` seed before the transaction (no network I/O inside), one `TransactionRunner.run` writes campaign + history + sponsorship + quota + outbox events; typed errors; no `INSERT … SELECT FROM "Product"`
- [X] T024 [US1] Pause/resume/end in `campaign-command.service.ts` (G1, G32): `domain/campaign-state.ts`, conditional update asserting one row, `campaignVersion` +1, history row, quota decrement on end, sponsorship event only when value changes (AS-11), resume guards read snapshot stores (AS-72 completes in US9)
- [X] T025 [US1] `MKT/application/campaign-query.service.ts`: list (keyset, `status` filter), read with `billedTodayMinor` from ledger charges (G1, G31)
- [X] T026 [US1] Six campaign routes in `MKT/api/ads.controller.ts`: `ShopScoped('shop.manage')` for create/pause/resume/end, `products.read` for list/read (G5), validated DTO → one service call → DTO, rate-limit decorators, problem+json codes (G37); run `test-spec.sh MKT/ads-campaigns.e2e-spec.ts` until green

## Phase 4: US2 — Shoppers see clearly labelled sponsored slots (P1)

**Goal**: `GET /ads/sponsored` from marketing tables only. **Independent test**: `ads-serving-clicks.e2e-spec.ts` AS-16–AS-22 (AS-23 via U2).

- [X] T027 [US2] Start `MKT/ads-serving-clicks.e2e-spec.ts` (`Sponsored listings: serving and clicks`) with serving cases: AS-16 headers/schema/order/tokens verify/no CPC or budget/metric, AS-17 category `all`/none/unknown/invalid, AS-18 one case per eligibility filter and its reversal, AS-19 one per shop/tie-break/`limit` bounds, AS-20 two calls differ, no raw identifiers in claims, AS-21 counters down → `200 []` + metric, database down → generic `503`, AS-22 121st `429`, limiter down → served; must fail now
- [X] T028 [US2] `MKT/application/serving.service.ts` (G7–G10, G19): one SQL on marketing tables only (campaign ⨝ product snapshot ⨝ shop snapshot; status/sandbox/stock/shop-active filters; ≤ 50 candidates per category), spend counter read with 100 ms timeout (empty list on failure), compare `(clicks+1) × cpc` to budget, `selectSlots`, token mint with fresh impression id and viewer hash (no user/anonymous id/address/price in claims)
- [X] T029 [US2] `GET /ads/sponsored` in `ads.controller.ts`: `Firewall({anonymous:true})`, `marketing.ads-serve.ip` policy, `Cache-Control: no-store`, `expiresAt`, price from snapshot, `sponsoredSlotsResponseSchema`, limiter down → served; serving cases green

## Phase 5: US3 — A click is counted once, shopper always lands on the product (P1)

**Goal**: never-throwing click endpoint. **Independent test**: serving-clicks AS-25–AS-36 (AS-24 token unit already green).

- [X] T030 [US3] Add click cases to `ads-serving-clicks.e2e-spec.ts`: AS-25 key rotation, AS-26 happy path (`302`, `Location`, one record parsed with `adClickRecordSchema`, salted key, marker TTL, no raw address), AS-27 duplicate, AS-28 20 simultaneous → one record, AS-29 each invalid token kind redirects home + metric reason, AS-30 no open redirect (injected params, spoofed host), AS-31 HEAD/prefetch not counted and later GET counted, AS-32 forged headers collapse and trusted proxy honoured, AS-33 click after pause valid, AS-34 publish down/timeout → `302`, marker removed, later click once, AS-35 store down → `302` + `filter_unavailable`, AS-36 300 rapid clicks all `302`; must fail now
- [X] T031 [US3] `MKT/application/click.service.ts` (L2; never throws; result union): verify token → marker `SET NX` → exact counters → spam decision (pure) → idempotent publish with 1 s timeout (marker removed on failure) → always redirect; address from trusted-proxy `request.ip` only (G14); no Postgres read on the click path (G19); record carries `product_id`, `viewer_hash`, `invalid_reason` (G17); salt via `hot-key-salt` (G18)
- [X] T032 [US3] `GET /ads/click/:token` in the controller: `@RateLimitExempt()`, HEAD/prefetch (`Purpose`/`Sec-Purpose`) not counted (G15), `Cache-Control: no-store`, redirect built from validated `front_host` + product id only (G36, AS-30); remove the `cf-connecting-ip` read; AS-25–AS-36 green

## Phase 6: US4 — Click spam is filtered before billing (P1)

**Independent test**: serving-clicks AS-38–AS-40 (AS-37, AS-41 units).

- [X] T033 [US4] Add cases: AS-38 25 concurrent from one address → 20 valid + 5 `ip_burst`, boundary, minute reset, AS-39 4th invalid per address and per viewer hash, other campaign unaffected, hour reset, AS-40 100 replays leave counters alone, fresh token still valid; must fail now
- [X] T034 [US4] Wire `redis-spam.counters.ts` + `spam-filter.ts` into `click.service.ts` (counters only after dedupe; thresholds from config, G16); cases green

## Phase 7: US5 — Counting is exact and survives crashes, replays, bad messages (P1)

**Independent test**: `ads-aggregation.e2e-spec.ts` AS-43–AS-49 (AS-42 unit).

- [X] T035 [US5] Write `MKT/ads-aggregation.e2e-spec.ts` (`Sponsored listings: click aggregation`): AS-43 1,000 clicks with duplicates/invalid, committed sums, read-committed visibility, AS-44 kill after send before commit then restart equals crash-free run, AS-45 zombie with same transactional id fenced (metric, only newer output), AS-46 duplicate aggregate row one effect, partials of 10 partitions summed, AS-47 each bad message dead-lettered, offsets advance, same message twice one effect (VII.4 pair), AS-48 late clicks counted in own minute + metric, hourly charge untouched, AS-49 same `click_id` twice, first verdict wins; must fail now
- [X] T036 [US5] Rewrite `MKT/infra/click-aggregator.service.ts` on S53 `TransactionalPipeline` (G20, G21): stable transactional id from `ads_aggregator_instance`, zod validation per message, dead-letter to `ads.clicks.dlq` inside the transaction, in-batch dedupe, offsets with commit; delete its `// S54 T037 audit` comment
- [X] T037 [US5] `fromBeginning: true` for a new group; start-up failure fails the start and readiness with a metric (G22, G23); `ads_late_clicks_total` (G24); graceful shutdown leaves no open transaction
- [X] T038 [US5] `MKT/infra/click-log.writer.ts` and `aggregate.writer.ts`: consumers → `ClickHouseSink.insert(…, { dedupeToken })` (S53 G-44, G25); `read_committed` on aggregates; first verdict kept in raw log
- [X] T039 [US5] Crash-at-named-point and zombie helpers in `testing/ads.fixtures.ts`; AS-43–AS-49 green; partition-count check for the salted key on the test stack (G39)

## Phase 8: US6 — Shops are charged exactly once per hour, never beyond budget (P1)

**Independent test**: `ads-billing.e2e-spec.ts` AS-50–AS-56 (AS-57 unit).

- [X] T040 [US6] Write `MKT/ads-billing.e2e-spec.ts` (`Sponsored listings: billing and reconciliation`), hourly part, through the job registry handler (never import the service): AS-50 `CHARGED`, reference `ad:<campaign>:<hour>`, `getBalances`, AS-51 retry and two racing runs one charge, AS-52 `LedgerBusy` → `PENDING`, rerun posts once; journal posted then crash → `created:false` → `CHARGED`, AS-53 `[30,20,5]` clicks caps + UTC reset, AS-54 remaining `24`/`25`/exact, AS-55 overdraw, ended billed, orphan skipped + metric, AS-56 default last closed hour, open hour refused, no aggregates no row; must fail now
- [X] T041 [US6] `MKT/application/hourly-billing.service.ts` (G26–G28, L4, L5): three separate transactions — marketing `PENDING` row (frozen `amountMinor`), ledger-only `postJournal` `AD_CHARGE` with stable reference, marketing `PENDING → CHARGED` conditional; `hour_not_closed` when `now < hourEnd + 5 min`; injected clock; "billed earlier today" includes adjustments
- [X] T042 [US6] `MKT/infra/ads.jobs.ts` replacing `ad-billing.jobs.ts` (S49): `declareJobType` strict payload contracts next to the `JobPayloads` augmentation, `maxAttempts`, schedule `5 * * * *` via `upsertSchedule` catching `InvalidScheduleError`, `@JobHandler`; no `JobsService.cancel`; both `// S54 T037 audit` sites gone; hourly cases green

## Phase 9: US7 — Daily reconciliation, closed days never rewritten (P1)

**Independent test**: billing AS-58–AS-66 (AS-67 unit).

- [X] T043 [US7] Add reconciliation cases to `ads-billing.e2e-spec.ts`: AS-58 over-billed `ADJUSTMENT +50/−50`, net 250, second run no-op, AS-59 `+75`, AS-60 missed hour (source `reconciliation`, same reference, later hourly no-op), AS-61 cap on recomputation, AS-62 closed day untouched, late click → adjustment dated now, 3-day window, explicit older day, AS-63 two at once one effect, AS-64 raw log down → `FAILED`, no money moved, next run works, AS-65 drift gauge + warning above 1%, none at or below, AS-66 UTC boundary, invalid excluded, duplicates collapsed; must fail now
- [X] T044 [US7] `MKT/application/reconciliation.service.ts` (G29, G30): last 3 closed days, `AdReconciliationRun` `RUNNING` (race loser skipped; `RUNNING` older than 30 min → `FAILED/abandoned`), numbered `AdBillingAdjustment` with reference `ad-adj:<campaign>:<hour>:<sequence>` `PENDING → POSTED`, never touches closed rows, source down → `FAILED` and the job returns normally, `ads_reconciliation_drift_ratio` + warning above 1%
- [X] T045 [US7] Register `ads.reconcile-day` (`30 2 * * *`) in `ads.jobs.ts`; reconciliation cases green; confirm `grep -rn sequelize.transaction MKT | grep -v share-link` prints nothing

## Phase 10: US8 — The advertiser sees what they are charged (P2)

**Independent test**: billing AS-68–AS-69.

- [X] T046 [US8] Add cases: AS-68 statement items + adjustments, keyset, roles, `404`, range (≤ 92 days, `from < to`) and cursor errors, AS-69 `Σ netAmountMinor` equals ledger movement for the references; must fail now
- [X] T047 [US8] `MKT/application/billing-statement.service.ts` + statement route in the controller (`shop.manage`, `marketing.ads-read.shop`); cases green

## Phase 11: US9 — Serving stays honest when products and shops change (P2)

**Independent test**: `ads-readmodels.e2e-spec.ts` AS-70–AS-75.

- [X] T048 [US9] Write `MKT/ads-readmodels.e2e-spec.ts` (`Sponsored listings: product and shop read models`): AS-70 late version ignored, duplicate one effect, invalid dead-lettered; AS-71 archive pauses, restore stays paused, delete ends, out of stock stops serving; AS-72 `409 product_unavailable`/`shop_inactive` on resume; AS-73 suspend/reinstate, reorder, offboarding, deleted ends, duplicate, invalid; AS-74 served immediately after create, lower version ignored; AS-75 every event parses with schema + envelope, forced rollback leaves no row or event; must fail now
- [X] T049 [US9] `MKT/application/snapshot-effects.service.ts` + `MKT/infra/product-snapshot.projector.ts` / `shop-snapshot.projector.ts` (G33, L8): subscribe `products.events` and `tenancy.events`, zod via the framework, `versionGuard`, dead-letter, snapshot upsert + campaign effect + outbox in one transaction; staleness ≤ 60 s
- [X] T050 [US9] Resume guards and seeding at creation use snapshot stores/R1 (AS-72, AS-74); wire `AdsProjectorModule` into the real `apps/projector` and start it (L-004, L-015); cases green

## Phase 12: US10 — Observable, safe to operate, inside boundaries (P2)

**Independent test**: `ads-platform.e2e-spec.ts` AS-76–AS-82 (AS-83 is an ops artifact).

- [X] T051 [US10] Write `MKT/ads-platform.e2e-spec.ts` (`Sponsored listings: operations and boundaries`): AS-76 scrape after scripted run, exact names/labels, no high-cardinality labels; AS-77 boot with each bad value fails naming the key (duplicate secrets, `share_link_secret` ignored); AS-78 every error parses as problem+json, injected 5xx generic `detail`; AS-79 log capture of serve→click→bill holds no token/address/secret; AS-80 ownership registry lists every table; AS-81 migrations up/down/up, `lock_timeout`, FKs dropped; AS-82 shutdown mid-batch leaves no open transaction, batch processed once after restart; must fail now
- [X] T052 [US10] Implement what the file exposes: metrics emission across services (`domain/ads-metrics.ts`), log hygiene (G35), generic 5xx path, shutdown hooks; cases green
- [X] T053 [US10] Remove `share_link_secret` (S37 follow-up) from `types.ts`, `api-config.service.ts`, `OTHER_SECRETS`, `libs/common/config/notifications-config.ts:43`, and the two ads exemptions in `packages/backend/scripts/check-no-wallclock.ts`; run `pnpm check:no-wallclock` and `share-links-platform.e2e-spec.ts` (smallest edit there if it needs the key; report it)

## Phase 13: Wiring, cleanup, polish

- [X] T054 Barrel `MKT/index.ts` (L3, D-8): export `AdsModule`, `AdsWorkerModule`, `AdsProjectorModule`, DTO types, event definitions only (ads lines; `ShareLinks*` untouched); switch `apps/core/src/core.module.ts`, `apps/worker/src/worker.module.ts`, `apps/projector` to import modules; sponsorship event definition exported for S32
- [X] T055 Delete `MKT/application/ads.service.ts`, `MKT/infra/ad-billing.jobs.ts`, `MKT/ads.e2e-spec.ts` only after all six new files pass (L6, D-7); keep `marketing-contracts.spec.ts` green; trending imports (S35) leave with the file
- [X] T056 [P] Ops artifacts (G40, rule 2): `packages/backend/scripts/load-tests/ads-clicks.test.js` + `"loadtest:ads-clicks"` in `package.json`; `docs/ops/runbooks/AdReconciliationDrift.md`; verify `quickstart.md` "Ops artifacts" lists SC-002, SC-005 (latency), SC-007 (alert), SC-008/AS-83, SC-009 (p99), UI journeys, and `specs/UNVERIFIED.md` has one row each with status "not run" (never describe as verified)
- [X] T057 [P] Sibling follow-ups and spec changes in `specs/domains/S36-sponsored-listings/gaps.md`: confirm "Sibling-spec follow-ups" (S32, S14, S37, S50, S03, S05, S54, W02, W04, S10) match what was built; "Spec changes" states whether any signed page moved (livespec check output); edit no sibling spec
- [X] T058 Final gates from `packages/backend`: `pnpm exec tsc --noEmit`, contracts `tsc --noEmit`, ESLint (backend, contracts), `check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict` (zero ads lines), `check:no-wallclock`, `python3 scripts/livespec/check.py`; unit batch `pnpm test -- libs/domains/marketing libs/common/config`
- [X] T059 Whole capability suite once, each of the six e2e files in its own fresh process (L-008); a batch without a summary line is a crash
- [ ] T060 `scripts/qa/fresh-run.sh` on an empty stack (L-012), then start real `apps/core`, `apps/worker`, `apps/projector` and confirm routes, aggregator, `ads.bill-hour`/`ads.reconcile-day` and the two projector consumers register (L-004, L-015)

## Gap and follow-up coverage

G1 T024/T025 · G2 T003/T023 · G3 T023 · G4 T005 · G5 T026 · G6 T020/T026/T029 · G7–G10 T028 · G11 T010/T013 · G12–G13 T019/T031 · G14 T031/T032 · G15 T032 · G16 T018/T034 · G17 T003/T031 · G18 T012/T031 · G19 T028/T031 · G20–G21 T036 · G22–G24 T037 · G25 T008/T038 · G26–G28 T041 · G29–G30 T044 · G31 T025/T047 · G32 T021/T024 · G33 T049 · G34 T010/T052 · G35 T052 · G36 T010/T032 · G37 T026/T052 · G38 T005 · G39 T008/T009/T039 · G40 T056 · L1 T015 · L2 T031 · L3 T054 · L4–L5 T017/T041 · L6 T055 · L7 T006/T007 · L8 T049 · D-6 T015/T031 · D-7 T017/T055 · D-8 T054 · D-12 T016/T023.
Sibling follow-ups taken: S05 T017/T023, S10 none (T057), S14 T017/T041/T044, S32 T021/T024, S35 T055, S37 T010/T053, S49 T042/T045, S50 T020, S53 T036/T038, W02 T029/T057.

## Dependencies

Phase 1 → Phase 2 → US1 (MVP) → US2 → US3 → US4. US5 is independent of US2–US4 once Phase 2 is done. US6 needs US1 and US5 aggregates; US7 needs US6; US8 needs US6/US7. US9 needs Phase 2 (snapshot stores) and feeds US1 resume guards and US2 serving. US10 last; Phase 13 after all.

## Parallel examples

- Phase 2: T007, T008, T009, T011–T015, T017–T020 touch different files.
- After Phase 2: US1 (T022–T026), US5 (T035–T039) and US9 (T048–T050) can proceed in parallel.
- T056 and T057 alongside T054.

## Implementation strategy

MVP = Phases 1–3 (campaign API with invariants and events). Then serving + click (US2–US4), counting (US5), money (US6–US8), read models and platform (US9–US10), then wiring, deletion of the old files, gates and the fresh-stack run.
