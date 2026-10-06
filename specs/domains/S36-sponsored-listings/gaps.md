# Gaps: S36 — Sponsored listings (domain `marketing`) versus `spec.md`

This is the implementation agent's to-do list. Scope is the ads half of `marketing` (S36); share links are S37 and are not listed.

Files in scope: `api/ads.controller.ts`, `application/ads.service.ts`, `domain/click-token.ts`, `infra/click-aggregator.service.ts`, `infra/ad-billing.jobs.ts`, `ads.module.ts`, `ads.e2e-spec.ts` (all under `packages/backend/libs/domains/marketing/`), the barrel `index.ts:7`, `apps/core/src/core.module.ts:11,142`, `apps/worker/src/worker.module.ts:11,71`, `migrations/20261001330000-sponsored-ads.js`, `clickhouse/080_ads.sql`, `db/ownership.ts:138-139`, `infra/stack/main.tf:41` (topics), `libs/common/config` (`share_link_secret`, `front_host`).

Existing tests: `ads.e2e-spec.ts` (5 cases: impression dedupe and forged token, hourly billing with cap and replay, reconciliation 12 → 10, `aggregateBatch`, trending weighting) and nothing under `domain/` for the token. It calls services directly (`ads.sponsored`, `ads.click`, `billHour`, `reconcileDay`), has no HTTP call, no 4xx, no role or tenant case, mocks the Kafka producer, and imports `ShopModel` (tenancy), `LedgerService` (payments) and `TrendingConsumer`/`TrendingService` (discovery).

## 1. Behaviour gaps

| # | What the code does or lacks | Where | Spec |
|---|---|---|---|
| G1 | Only `createCampaign` exists: no list, read, pause, resume, end; `PAUSED` is unreachable; no state machine, no history, no events | `ads.controller.ts:23-29`, `ads.service.ts:40-47` | FR-001 – FR-008, AS-08 – AS-15 |
| G2 | `createCampaign` returns the raw query result (a row array), not a DTO; the request carries `category`, `cpcCents`, `dailyBudgetCents`; validators allow `cpcCents` of any size and `dailyBudgetCents` below the CPC; no currency | `ads.controller.ts:13-18`, `ads.service.ts:40-47` | FR-001, FR-002, AS-01, AS-02 |
| G3 | The shop and product ownership check is a SQL `INSERT … SELECT … FROM "Product"` that silently inserts nothing and returns `[]` (no `404`) when the product is not the shop's; archived and sandbox products are accepted | `ads.service.ts:42-43` | FR-001, FR-003, AS-04, AS-05 |
| G4 | No uniqueness: many campaigns per product and per shop | migration `:10-20` | FR-004, AS-06, AS-07 |
| G5 | `ShopScoped('products.write')` lets STAFF spend the shop's money | `ads.controller.ts:25` | FR-001, AS-03 |
| G6 | No rate limit on campaign mutations or on serving; `skipThrottle: true` is set on the click route (correct for clicks) but nothing replaces it for serving | `ads.controller.ts:31,38` | FR-008, FR-016, AS-14, AS-22 |
| G7 | `category` is not validated and defaults to the literal `'all'`, which matches only campaigns whose category is `all` | `ads.controller.ts:33-34`, `ads.service.ts:54` | FR-011, AS-17 |
| G8 | Serving joins `"Product"` for title and stock, ignores product status, sandbox flag and shop status, has no `limit`, no one-per-shop rule, no deterministic tie-break (`ORDER BY cpcCents DESC` only) | `ads.service.ts:52-56,60` | FR-010, FR-011, AS-18, AS-19 |
| G9 | Response is a bare array with a `viewer` hash nobody needs, no `Cache-Control` (a shared cache could replay one impression ID to many shoppers), no `expiresAt`, no price | `ads.service.ts:61-66`, `ads.controller.ts:31-35` | FR-012, AS-16, AS-20 |
| G10 | Budget pacing reads Redis spend counters; if Redis fails the request throws a `500` instead of returning no ads | `ads.service.ts:57` | FR-015, AS-21 |
| G11 | Token: signing key is `share_link_secret \|\| jwt_secret` (shared with share links and sessions); the signature is truncated to 32 base64url characters; no key ID or rotation; claims are not schema-validated (`JSON.parse(...) as ClickClaims`, can throw on a signed-but-malformed payload); no viewer hash; short single-letter claims | `ads.service.ts:36-38`, `domain/click-token.ts:19-28` | FR-013, FR-014, AS-24, AS-25, AS-77 |
| G12 | Dedupe marker (`SET NX`, 3,600 s) is correct in idea but happens before the filter and the publish; if the publish throws, the marker stays and the click is lost for good; no timeout on Redis or Kafka calls | `ads.service.ts:76-84` | FR-022, FR-026, AS-34 |
| G13 | Redis or Kafka failure on the click path propagates as a `500`: the shopper gets no redirect | `ads.service.ts:76-90`, `ads.controller.ts:39-44` | FR-020, FR-026, AS-34, AS-35, AS-36 |
| G14 | The client address is `cf-connecting-ip` from any caller, so a forged header defeats the burst filter | `ads.controller.ts:41` | FR-024, AS-32 |
| G15 | `HEAD` and prefetch requests count (and consume the impression) | `ads.controller.ts:38-45` | FR-023, AS-31 |
| G16 | Spam filter has one rule (address per minute; the counter correctly runs only after dedupe), no repeat-clicker rule, no viewer rule, no reason (only `valid`), the threshold is a constant not configuration, and the counter's expiry is reset on every call (`multi().incr().expire()`) | `ads.service.ts:15,78-81` | FR-027, FR-028, AS-38 – AS-41, AS-77 |
| G17 | Click record lacks `product_id`, `viewer_hash`, `invalid_reason`; `ts` is built from the server clock without a schema; no `packages/contracts` schema | `ads.service.ts:18-25,83` | FR-030, AS-26 |
| G18 | Hot-key salt is `Math.random()`: the same click re-sent goes to a random partition; no test of distribution | `ads.service.ts:84` | FR-030, AS-37 |
| G19 | A click on a campaign paused after serving is still recorded (good), but the budget counter increment reads `cpcCents` from Postgres on the hot click path (one query per valid click) and runs after the publish | `ads.service.ts:85-88` | FR-025, AS-33; remove the query (the spend counter is a pacing hint only; the price comes from the campaign read at serve time or the billing job) |
| G20 | Aggregator transactional ID is `ads-click-aggregator-<hostname>-<pid>`: a restarted instance gets a new identity, so a zombie is never fenced | `infra/click-aggregator.service.ts:52` | FR-032, AS-45 |
| G21 | Aggregator silently drops unparseable messages (`catch { return [] }`), validates nothing (no zod), has no dead-letter path, counts a click ID that appears twice in a batch twice, and uses the batch's first offset even when the batch contains only some of the records | `infra/click-aggregator.service.ts:70-76`, `aggregateBatch:23-36` | FR-034, FR-035, AS-42, AS-47 |
| G22 | `fromBeginning: false` on first start loses clicks produced before the group existed; the group is created on first deploy only | `infra/click-aggregator.service.ts:56` | FR-031 (a new group must start at the earliest committed position of the topic) |
| G23 | The aggregator swallows start-up failure with a warning (`not started`) and the app keeps running with no aggregation; no metric | `infra/click-aggregator.service.ts:58-60` | FR-038, AS-76 |
| G24 | Lateness is not measured (no `ads_late_clicks_total`); minute is cut from the string `ts` | `infra/click-aggregator.service.ts:24-33` | FR-036, AS-48 |
| G25 | Raw-log table keeps the *latest* verdict per click ID (ReplacingMergeTree default), not the first-recorded one | `clickhouse/080_ads.sql:14-16` | FR-034, AS-49 |
| G26 | Hourly job bills `min(clicks × cpc, remaining)`: a partial click can be charged; `billedEarlierToday` sums `amountCents` of the day's runs including adjustments' effect incorrectly (adjustments are not in the sum) | `infra/ad-billing.jobs.ts:86-92` | FR-042, AS-53, AS-54 |
| G27 | `charge` writes `AdBillingRun` and calls `LedgerService.post` inside one Postgres transaction (cross-domain transaction, IX.4); a ledger failure rolls back the run row so there is no `PENDING` state and no stable ledger reference (`journalId` is a random UUIDv7) | `infra/ad-billing.jobs.ts:84-103` | FR-041, FR-043, AS-50 – AS-52 |
| G28 | Hourly job takes `Date.now()` (domain-style code reads the clock directly), bills at `:05` without checking aggregates are complete, accepts an explicit hour that has not closed | `infra/ad-billing.jobs.ts:46`, `:40` | FR-040, AS-56 |
| G29 | Reconciliation: one pass per day (`reconciledClicks IS NULL`), one adjustment per hour ever, no window, no sequence, no period-close state, no run record, no `FAILED` path when ClickHouse is down (exception), no drift metric; a run with no billing row posts an `AD_CHARGE` with a random journal ID | `infra/ad-billing.jobs.ts:56-81,105-122` | FR-050 – FR-056, AS-58 – AS-66 |
| G30 | Reconciliation ignores the budget cap when recomputing | `infra/ad-billing.jobs.ts:61-81` | FR-050, AS-61 |
| G31 | No advertiser statement; `billedTodayMinor` does not exist | — | FR-058, FR-059, AS-13, AS-68, AS-69 |
| G32 | No outbox events: no `marketing.campaign_*`, no `marketing.product_sponsorship_changed` (S32 waits for it) | — | FR-007, AS-75 |
| G33 | No read models, no consumers of `catalog.product_*` or `tenancy.shop_*`; archived or deleted products and suspended shops keep serving | — | FR-060 – FR-063, AS-70 – AS-75 |
| G34 | No metrics, no config validation (`share_link_secret` may be empty and falls back to the JWT secret), no startup check for thresholds | `ads.service.ts:36-38` | FR-070, FR-071, AS-76, AS-77 |
| G35 | Logs: a reconciliation log line prints campaign ID and hour (fine); nothing logs tokens, but nothing proves it | `infra/ad-billing.jobs.ts:120` | AS-79 |
| G36 | The click redirect builds `${front_host}${redirectTo}` from config at call time without validating that `front_host` is an origin | `ads.controller.ts:44` | FR-021, AS-30, AS-77 |
| G37 | Errors are NestJS defaults (no `code`); campaign create returns `[]` or a 500 on bad ownership | `ads.controller.ts`, `ads.service.ts:40-47` | AS-78 |
| G38 | Migrations: `AdCampaign` has foreign keys to `Shop` and `Product` (cross-owner), money columns are `...Cents`, `AdBillingRun` has no `state`, `source`, `billableClicks`, `cappedClicks` or ledger reference column, no history, sponsorship, snapshot, adjustment or reconciliation tables, no unique constraint for open campaigns, no `lock_timeout` | `migrations/20261001330000-sponsored-ads.js:7-33` | FR-004, FR-005, FR-041, AS-80, AS-81 |
| G39 | Topic `ads.clicks` is declared only in Terraform with the default domain partition count; no DLQ topic for it; `ads.click-aggregates` also; ClickHouse queue tables read `ads.clicks` with no schema for the new fields | `infra/stack/main.tf:41`, `clickhouse/080_ads.sql:33-51` | FR-030, FR-035, AS-47, AS-83 |
| G40 | Capacity proof (10M events, 50k/s) is claimed by the notes and has no script | `docs/showcase/sections/SD-32-trending-sponsored-clicks.md` "Proof" | AS-83 |

## 2. Layering and boundary gaps (constitution)

| # | Gap | Where | Rule | Fix |
|---|---|---|---|---|
| L1 | `application/ads.service.ts` injects `Sequelize` and runs raw SQL; `infra/click-aggregator.service.ts` imports from `application/` (`ADS_CLICKS_TOPIC`, `ClickRecord`) | `ads.service.ts:30-38`, `click-aggregator.service.ts:6` | I.2, III.1, debt **D-6** | Repository ports in `domain/`, adapters in `infra/`; move the topic constant and the record type to `domain/`; the aggregator depends on `domain/` only |
| L2 | The click path mixes use-case logic, Redis, Kafka and money reads in one service method | `ads.service.ts:72-91` | I.1 | Split: serve service, click service, spam-filter pure rule in `domain/`, ports for marker, counters, click log |
| L3 | Barrel exports `AdsModule`, `AdsWorkerModule` and S37's `LinkClicksProjector`; apps wire `AdsWorkerModule` directly | `index.ts:7-9`, `worker.module.ts:71` | X.4, debt **D-8** | Export `AdsModule`, `AdsWorkerModule`, `AdsProjectorModule` (new, for `apps/projector`) and DTO/event contracts only |
| L4 | `AdsWorkerModule` imports `LedgerModule` from the payments barrel and `AdBillingJobs` injects `LedgerService` and uses `LEDGER_ACCOUNTS`, `shopAccount` | `ads.module.ts:6,17`, `ad-billing.jobs.ts:8,17,100,119` | IV.1, debt **D-7** | **R1**: S14's `postJournal`, `getBalances`, `shopAccount`, `LEDGER_ACCOUNTS` through `@app/domains/payments`; delete the `LedgerService.post` and `balance` usage |
| L5 | A single transaction writes `AdBillingRun` and ledger tables | `ad-billing.jobs.ts:84-103` | IX.4 | Run row in the marketing transaction; ledger posting in a ledger-only transaction; reference-based idempotency (G27) |
| L6 | `ads.e2e-spec.ts` imports `ShopModel` (tenancy), `getModelToken(Shop)`, `LedgerService`, `TrendingConsumer`, `TrendingService`, and uses `createCampaign`/`click`/`billHour` directly | `ads.e2e-spec.ts:11-21,62-66` | VII.2, debt **D-7** (test side), S35 gap T57 | Replace with the six feature files of `test-plan.md`; fixtures through the shared seed helpers (which may touch every table, IX.6); balances through `getBalances` |
| L7 | `AdCampaign.shopId` and `productId`, `AdBillingRun.campaignId` have foreign keys (the first two to other owners) | `migrations/…sponsored-ads.js:12-13` | IX.4 | Drop the two cross-owner foreign keys (plain UUID columns, expand/contract); keep the internal one to `AdCampaign` |
| L8 | The aggregator and billing jobs are in `infra/` and call each other's types, but there is no `AdsProjectorModule` for the two read-model consumers | — | X.2, IV.5 | New consumers in `infra/`, deployed by `apps/projector`; document the idempotency mechanism (version-guarded upsert) |

## 3. Debt-register rows that name `marketing` or apply to it

`pnpm --dir packages/backend check:table-ownership` could not be run in this session (the command needed an approval the run did not have), so the lines below are derived by reading the code. **The implementation agent runs the command first and reconciles this list with its `marketing` lines.** Every row is paid under test by this capability.

| Debt | Row says | S36 lines | Replaced by |
|---|---|---|---|
| **D-6** (open) | Layering inside domains: `api/` and `application/` import `infra/` directly | `application/ads.service.ts` (injected `Sequelize`, raw SQL), `infra/click-aggregator.service.ts:6` (`infra → application`) | Repository and cache ports in `domain/`, adapters in `infra/` (L1, L2) |
| **D-7** (open) | Other domains import `*Model` exports to query or associate them | `ads.e2e-spec.ts:13,21` `ShopModel` (tenancy) and `SequelizeModule.forFeature([Shop])`; `ad-billing.jobs.ts:8`, `ads.module.ts:6` `LedgerService`/`LedgerModule` (payments barrel) | `ShopModel`: delete (test fixtures use the seed helpers; production code reads shop state through **R3**, the shop read model). `LedgerService`/`LedgerModule`: **R1** `postJournal`, `getBalances`, `shopAccount`, `LEDGER_ACCOUNTS` from S14; then payments drops the model export |
| **D-12** (open) | Raw SQL on tables owned by another domain | `ads.service.ts:42-43` (`INSERT … SELECT FROM "Product"`), `ads.service.ts:53-54` (`JOIN "Product"`) | Ownership and category at creation: **R1** `ProductQueryService.getProductsByIds(ids, {shopId})` (S05). Title, stock and status for serving: **R3** product read model (`catalog.product_*` events, version-guarded consumer in `AdsProjectorModule`). Shop state: **R3** from `tenancy.shop_*` events |
| **D-8** (open) | Barrels export infrastructure internals because apps wire them directly | `index.ts:7-9` | Apps import `AdsModule`, `AdsWorkerModule`, `AdsProjectorModule` only (L3) |
| **D-11, D-15, D-17** | Not marketing | none | n/a (S36 has no cycle with payments: it calls the ledger and the ledger never calls it) |

Lines of `check:table-ownership` that name `marketing` for share links (`share-link.service.ts`) belong to S37.

## 4. Suggested order

1. Contracts first: `packages/contracts` schemas (`createAdCampaignRequestSchema`, `adCampaignSchema`, `adCampaignPageSchema`, `adCampaignDetailSchema`, `adBillingPageSchema`, `sponsoredSlotsResponseSchema`, `adClickRecordSchema`, event schemas), config keys, ownership registry, migrations (expand: new columns/tables; drop cross-owner FKs; ClickHouse DDL additions).
2. Pure `domain/`: token, state machine, ranking, spam decision, salting, batch aggregation, billing and adjustment math, each with its unit spec (AS-15, AS-23, AS-24, AS-37, AS-41, AS-42, AS-57, AS-67).
3. Campaign API with outbox events (AS-01 – AS-14, AS-75) and the product/shop read models and consumers (AS-70 – AS-74).
4. Serving and click endpoints (AS-16 – AS-40).
5. Aggregator (AS-43 – AS-49).
6. Billing, reconciliation, statement (AS-50 – AS-69).
7. Platform: metrics, config validation, log hygiene, shutdown, boundaries gates (AS-76 – AS-82); the `loadtest:ads-clicks` script (AS-83).
8. Delete `ads.e2e-spec.ts`, swap `core.module.ts`/`worker.module.ts`/`projector.module.ts` wiring, update the barrel, run `check:table-ownership --strict` (marketing lines must be zero for ads).
9. Record in `plan.md` Complexity Tracking: the V.5 exception for the click redirect; the pool-size arithmetic for the worker's two Postgres users (III.12).
