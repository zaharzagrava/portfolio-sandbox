---
id: S36
title: Sponsored listings (campaigns, signed click tokens, click counting, hourly billing, daily reconciliation)
kind: capability
status: draft
depends_on: [S01, S03, S05, S14, S49, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, projection-and-replay, job-scheduler-lease, transaction-runner, outbox-task-queue]
models: []
scope:
  - packages/backend/libs/domains/marketing/api/ads.controller.ts
  - packages/backend/libs/domains/marketing/api/ads-zod.pipe.ts
  - packages/backend/libs/domains/marketing/application/campaign-*.ts
  - packages/backend/libs/domains/marketing/application/billing-statement.service.ts
  - packages/backend/libs/domains/marketing/application/serving.service.ts
  - packages/backend/libs/domains/marketing/application/click.service.ts
  - packages/backend/libs/domains/marketing/application/hourly-billing.service.ts
  - packages/backend/libs/domains/marketing/application/reconciliation.service.ts
  - packages/backend/libs/domains/marketing/application/snapshot-effects.service.ts
  - packages/backend/libs/domains/marketing/application/events/ads-events.ts
  - packages/backend/libs/domains/marketing/domain/ads-*.ts
  - packages/backend/libs/domains/marketing/domain/campaign-state.ts
  - packages/backend/libs/domains/marketing/domain/slot-ranking.ts
  - packages/backend/libs/domains/marketing/domain/click-token.ts
  - packages/backend/libs/domains/marketing/domain/click-record.ts
  - packages/backend/libs/domains/marketing/domain/click-aggregation.ts
  - packages/backend/libs/domains/marketing/domain/hot-key-salt.ts
  - packages/backend/libs/domains/marketing/domain/spam-filter.ts
  - packages/backend/libs/domains/marketing/domain/billing-math.ts
  - packages/backend/libs/domains/marketing/domain/adjustment-math.ts
  - packages/backend/libs/domains/marketing/infra/sequelize-*.ts
  - packages/backend/libs/domains/marketing/infra/redis-impression.marker.ts
  - packages/backend/libs/domains/marketing/infra/redis-spam.counters.ts
  - packages/backend/libs/domains/marketing/infra/redis-spend.counter.ts
  - packages/backend/libs/domains/marketing/infra/kafka-click.log.ts
  - packages/backend/libs/domains/marketing/infra/kafka-batch-consumer.ts
  - packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts
  - packages/backend/libs/domains/marketing/infra/click-log.writer.ts
  - packages/backend/libs/domains/marketing/infra/aggregate.writer.ts
  - packages/backend/libs/domains/marketing/infra/clickhouse-ad.reader.ts
  - packages/backend/libs/domains/marketing/infra/ledger.adapter.ts
  - packages/backend/libs/domains/marketing/infra/catalog.adapter.ts
  - packages/backend/libs/domains/marketing/infra/shop-directory.adapter.ts
  - packages/backend/libs/domains/marketing/infra/product-snapshot.projector.ts
  - packages/backend/libs/domains/marketing/infra/shop-snapshot.projector.ts
  - packages/backend/libs/domains/marketing/infra/ads.jobs.ts
  - packages/backend/libs/domains/marketing/ads*.module.ts
  - packages/contracts/src/marketing/ads.ts
  - packages/backend/libs/common/config/ads-config.ts
  - packages/backend/migrations/20261013150000-ads-campaigns-v2.js
  - packages/backend/migrations/20261013150100-ads-drop-cross-owner-fks.js
  - packages/backend/clickhouse/081_ads_v2.sql
---
# S36 - Sponsored listings (campaigns, signed click tokens, click counting, hourly billing, daily reconciliation)
## Purpose
A shop sponsors one of its products at a price per click (CPC) with a daily budget, and the product becomes eligible for up to three labelled sponsored slots. Each slot carries a signed, expiring click token for one served impression. The click endpoint verifies it, counts the impression at most once, filters click spam, records the click and always redirects the shopper to the product. A transactional streaming aggregator counts valid clicks per campaign per minute, an hourly job charges each shop once, capped by its daily budget, and a daily reconciliation recomputes from the raw log and posts adjustments dated now, so a closed day is never rewritten. The advertiser reads a statement that agrees with the ledger.

## Entry points
- `POST|GET /api/shops/:shopId/ads/campaigns`, `GET …/:campaignId`, `POST …/:campaignId/(pause|resume|end)` and `GET …/:campaignId/billing`. [code: packages/backend/libs/domains/marketing/api/ads.controller.ts#AdsController]
- The public `GET /api/ads/sponsored` and `GET /api/ads/click/:token`. [code: packages/backend/libs/domains/marketing/api/ads.controller.ts#AdsController]
- Topics `ads.clicks`, `ads.click-aggregates`, `ads.clicks.dlq` and `marketing.events` (`marketing.campaign_*`, `marketing.product_sponsorship_changed` v1). [code: packages/backend/libs/domains/marketing/application/events/ads-events.ts#ProductSponsorshipChanged]
- Consumers `ads-click-aggregator`, `ads-click-log-writer`, `ads-aggregate-writer`, `ads-product-snapshot` and `ads-shop-snapshot`; jobs `ads.bill-hour` and `ads.reconcile-day`. [code: packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#ClickAggregator] [code: packages/backend/libs/domains/marketing/infra/ads.jobs.ts#AdsJobs]

## Rules
- **S36.R-01** Creating a campaign MUST answer `201` with the contract body (category copied from the product, `cpcMinor`, `dailyBudgetMinor`, `EUR`, `ACTIVE`, version 1) and write the campaign, its history row, the shop's quota and the outbox events `marketing.campaign_created` and `marketing.product_sponsorship_changed` in one transaction. [proof: S36 AS-01] [code: packages/backend/libs/domains/marketing/application/campaign-command.service.ts#CampaignCommandService]
- **S36.R-02** A create body MUST be refused with `400` `validation_failed` naming the field, writing nothing, for a missing or invalid `productId`, a CPC outside 1 to 10,000, a daily budget outside 100 to 10,000,000, a non-integer or non-number and any unknown field; a budget below the CPC MUST be `422` `budget_below_cpc`. [proof: S36 AS-02] [code: packages/contracts/src/marketing/ads.ts#createAdCampaignRequestSchema]
- **S36.R-03** Campaign mutations MUST need `shop.manage` (owner and admin), reads `products.read` and the statement `payouts.read`; a call without credentials MUST be `401`, a member without the permission `403` `permission_denied`, and nothing changes on a refusal. [proof: S36 AS-03] [code: packages/backend/libs/domains/marketing/api/ads.controller.ts#AdsController]
- **S36.R-04** Another shop's campaign, shop or product MUST answer `404` with the same body as an unknown one, change nothing and publish nothing. [proof: S36 AS-04] [code: packages/backend/libs/domains/marketing/application/campaign-query.service.ts#CampaignQueryService]
- **S36.R-05** An archived or sandbox product MUST be refused with `422` `product_not_sponsorable`, an unknown one with `404`, and an out-of-stock one accepted. [proof: S36 AS-05] [code: packages/backend/libs/domains/marketing/application/campaign-command.service.ts#CampaignCommandService]
- **S36.R-06** At most one non-ended campaign MUST exist per product, enforced by a partial unique index: a second create is `409` `campaign_already_exists`, a create after the first ended succeeds, and two racing creates give one `201` and one `409`. [proof: S36 AS-06] [code: packages/backend/libs/domains/marketing/infra/sequelize-campaign.store.ts#SequelizeCampaignStore]
- **S36.R-07** A shop MUST hold at most 50 non-ended campaigns, reserved by a conditional quota upsert in the same transaction: the 51st is `422` `campaign_limit_reached`, two creates racing at 49 give one winner, and ending a campaign frees its place. [proof: S36 AS-07] [code: packages/backend/libs/domains/marketing/infra/sequelize-campaign.store.ts#SequelizeCampaignStore]
- **S36.R-08** Pause, resume and end MUST change the status, reason and version by a conditional update, write a history row and publish `marketing.campaign_paused|resumed|ended` plus the sponsorship signal in the same transaction. [proof: S36 AS-08] [code: packages/backend/libs/domains/marketing/application/campaign-lifecycle.service.ts#CampaignLifecycleService]
- **S36.R-09** An illegal transition MUST answer `409` `invalid_transition` naming the state and the action and change nothing; two racing transitions MUST give one `200` and one `409`. [proof: S36 AS-09, S36 AS-10] [code: packages/backend/libs/domains/marketing/domain/campaign-state.ts#nextStatus]
- **S36.R-10** `ACTIVE` MUST go to `PAUSED` or `ENDED`, `PAUSED` to `ACTIVE` or `ENDED`, `ENDED` nowhere, and a product is sponsored exactly while its campaign is `ACTIVE`. [proof: S36 AS-15] [code: packages/backend/libs/domains/marketing/domain/campaign-state.ts#isSponsored]
- **S36.R-11** `marketing.product_sponsorship_changed` MUST be published only when the sponsored value of a product changes, with a version that rises by one per change. [proof: S36 AS-11] [code: packages/backend/libs/domains/marketing/application/campaign-lifecycle.service.ts#CampaignLifecycleService]
- **S36.R-12** The campaign list MUST be keyset-paged newest first by a signed cursor bound to the shop, filter by status, and refuse a bad limit, status or cursor with `400`. [proof: S36 AS-12] [code: packages/backend/libs/domains/marketing/domain/ads-cursor.ts#decodeCursor]
- **S36.R-13** The campaign detail MUST add `billedTodayMinor`, the charges and posted adjustments of the current UTC day, never an estimate. [proof: S36 AS-13] [code: packages/backend/libs/domains/marketing/application/campaign-query.service.ts#CampaignQueryService]
- **S36.R-14** Mutations MUST be limited to 60 a minute per shop by `marketing.ads-write.shop`, answering `429` with `Retry-After` and failing closed with `503` `rate_limiter_unavailable` when the limiter store is down. [proof: S36 AS-14] [code: packages/backend/libs/domains/marketing/rate-limit-policies.ts#marketingRatePolicies]
- **S36.R-15** `GET /ads/sponsored` MUST answer `private, no-store` with up to three labelled items ordered by CPC then campaign id, at most one per shop, each with a tokenised `clickUrl` and no CPC, budget or viewer identifier. [proof: S36 AS-16, S36 AS-19, S36 AS-23] [code: packages/backend/libs/domains/marketing/application/serving.service.ts#ServingService]
- **S36.R-16** `category=all` or none MUST serve every category, an unknown category none, and an invalid category or limit `400`. [proof: S36 AS-17] [code: packages/contracts/src/marketing/ads.ts#sponsoredQuerySchema]
- **S36.R-17** A campaign MUST be served only while it is `ACTIVE`, its product (read model) is active, in stock and not a sandbox product, its shop is active and not offboarding, and today's spend plus one click fits the budget; it MUST be served again when the condition is reversed. [proof: S36 AS-18] [code: packages/backend/libs/domains/marketing/infra/sequelize-campaign.store.ts#SequelizeCampaignStore]
- **S36.R-18** Every response MUST carry fresh tokens whose readable claims are an impression id, campaign, shop, product, expiry and a keyed viewer hash, with no user id, anonymous id, address or price. [proof: S36 AS-20] [code: packages/backend/libs/domains/marketing/domain/click-token.ts#signClickToken]
- **S36.R-19** Serving MUST answer an empty list, counting `degraded`, when the spend counters cannot be read within 100 ms, and a generic `503` when the database fails. [proof: S36 AS-21] [code: packages/backend/libs/domains/marketing/application/serving.service.ts#ServingService]
- **S36.R-20** Serving MUST be limited to 120 a minute per address by `marketing.ads-serve.ip` (`429`), and keep serving when the limiter store is down. [proof: S36 AS-22] [code: packages/backend/libs/domains/marketing/rate-limit-policies.ts#marketingRatePolicies]
- **S36.R-21** A click token MUST be `v1.<key id>.<payload>.<signature>` signed with a domain-separated subkey, verified in constant time, its claims shape-checked, `now >= expiry` expired, a previous key honoured while configured, and verification never throws. [proof: S36 AS-24, S36 AS-25] [code: packages/backend/libs/domains/marketing/domain/click-token.ts#verifyClickToken]
- **S36.R-22** A click on a served impression MUST answer `302` to the storefront product page with `no-store`, publish exactly one record (impression id as click id, salted key, hashed address, valid) and set a marker that outlives the token by 5 minutes. [proof: S36 AS-26] [code: packages/backend/libs/domains/marketing/application/click.service.ts#ClickService]
- **S36.R-23** An impression MUST count at most once: a repeated or simultaneous click answers the same redirect and publishes nothing more. [proof: S36 AS-27, S36 AS-28, S36 AS-40] [code: packages/backend/libs/domains/marketing/infra/redis-impression.marker.ts#RedisImpressionMarker]
- **S36.R-24** An invalid, forged, altered, oversized, wrongly keyed or expired token MUST redirect to the storefront home, publish nothing, create no marker and be counted by reason. [proof: S36 AS-29] [code: packages/backend/libs/domains/marketing/application/click.service.ts#ClickService]
- **S36.R-25** The redirect target MUST be built only from the configured storefront origin and the signed product id, whatever query parameters or `Host` the request carries. [proof: S36 AS-30] [code: packages/backend/libs/domains/marketing/api/ads.controller.ts#AdsController]
- **S36.R-26** `HEAD` and prefetch requests MUST get the redirect without recording a click or consuming the impression. [proof: S36 AS-31] [code: packages/backend/libs/domains/marketing/api/ads.controller.ts#AdsController]
- **S36.R-27** The client address MUST be the platform's trusted-proxy resolution, never a client header on its own, and be stored only as a keyed hash. [proof: S36 AS-32] [code: packages/backend/libs/domains/marketing/domain/click-token.ts#hashAddress]
- **S36.R-28** A click on an impression served while the campaign was eligible MUST be recorded valid even after the campaign was paused or ended. [proof: S36 AS-33] [code: packages/backend/libs/domains/marketing/application/click.service.ts#ClickService]
- **S36.R-29** A publish that fails or exceeds 1 second MUST still redirect, remove the marker and count `record_failed`, so a later click counts once. [proof: S36 AS-34] [code: packages/backend/libs/domains/marketing/infra/kafka-click.log.ts#KafkaClickLog]
- **S36.R-30** A dedupe or counter store that is down or slower than 100 ms MUST still redirect and record the click invalid `filter_unavailable`; the click endpoint MUST never answer an error status or `429`. [proof: S36 AS-35, S36 AS-36] [code: packages/backend/libs/domains/marketing/application/click.service.ts#ClickService]
- **S36.R-31** The hot-key salt MUST be a deterministic function of the click id within 0 to 9 and spread evenly. [proof: S36 AS-37] [code: packages/backend/libs/domains/marketing/domain/hot-key-salt.ts#hotKeySalt]
- **S36.R-32** More than 20 clicks a minute from one address MUST be recorded invalid `ip_burst`, exactly under concurrency, restarting each UTC minute; replays MUST not advance the counters. [proof: S36 AS-38, S36 AS-40] [code: packages/backend/libs/domains/marketing/infra/redis-spam.counters.ts#RedisSpamCounters]
- **S36.R-33** More than 3 clicks an hour on one campaign from one address or one viewer MUST be recorded invalid `repeat_clicker`, other campaigns unaffected, restarting each UTC hour. [proof: S36 AS-39] [code: packages/backend/libs/domains/marketing/domain/spam-filter.ts#decideSpam]
- **S36.R-34** The spam decision MUST be pure, give `ip_burst` precedence, be monotone and reject thresholds below 1 or not integers. [proof: S36 AS-41] [code: packages/backend/libs/domains/marketing/domain/spam-filter.ts#decideSpam]
- **S36.R-35** A batch MUST aggregate per campaign and minute of `received_at`, count a click id once with its first verdict, be independent of record order and carry the batch identity. [proof: S36 AS-42] [code: packages/backend/libs/domains/marketing/domain/click-aggregation.ts#aggregateBatch]
- **S36.R-36** The aggregator MUST commit a batch's aggregates and offsets together under a stable transactional id, so committed sums equal the distinct valid and invalid clicks, a crash before commit shows nothing and a restart equals a crash-free run. [proof: S36 AS-43, S36 AS-44] [code: packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#ClickAggregator]
- **S36.R-37** A zombie instance with the same transactional id MUST be fenced: its commit is rejected, `ads_aggregator_fenced_total` increments and only the newer output exists. [proof: S36 AS-45] [code: packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#ClickAggregator]
- **S36.R-38** An aggregate delivered twice MUST have one effect and the salted partials of a campaign-minute MUST be summed. [proof: S36 AS-46] [code: packages/backend/libs/domains/marketing/infra/aggregate.writer.ts#AggregateWriter]
- **S36.R-39** A bad message (invalid JSON, shape, verdict, future or stale time) MUST be dead-lettered with its reason inside the transaction without blocking the stream, and a rewound consumer MUST have a single effect. [proof: S36 AS-47] [code: packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#ClickAggregator]
- **S36.R-40** A late click MUST be counted in its own minute and measured, never moved, and the hour already charged MUST not be touched. [proof: S36 AS-48] [code: packages/backend/libs/domains/marketing/domain/click-aggregation.ts#isLate]
- **S36.R-41** The raw log MUST keep every record and be read with the first recorded verdict per click id. [proof: S36 AS-49] [code: packages/backend/libs/domains/marketing/infra/click-log.writer.ts#ClickLogWriter]
- **S36.R-42** The hourly job MUST charge each campaign's committed aggregates of the last closed hour once: a `PENDING` run row, a ledger-only `AD_CHARGE` journal with the stable reference `ad:<campaign>:<hour>`, then `CHARGED`. [proof: S36 AS-50] [code: packages/backend/libs/domains/marketing/application/hourly-billing.service.ts#HourlyBillingService]
- **S36.R-43** A repeated, overlapping or crashed hourly run MUST converge on one charge: a ledger that refuses leaves the run `PENDING` to be finished with its first amounts, and a journal already posted answers `created: false`. [proof: S36 AS-51, S36 AS-52] [code: packages/backend/libs/domains/marketing/infra/ledger.adapter.ts#LedgerAdapter]
- **S36.R-44** The charge MUST be whole clicks only, capped by the day's remaining budget, and the budget MUST restart at 00:00 UTC. [proof: S36 AS-53, S36 AS-54, S36 AS-57] [code: packages/backend/libs/domains/marketing/domain/billing-math.ts#billable]
- **S36.R-45** Ad charges MAY overdraw a shop, a campaign ended after serving MUST still be billed, and aggregates of an unknown campaign MUST be skipped and counted. [proof: S36 AS-55] [code: packages/backend/libs/domains/marketing/application/hourly-billing.service.ts#HourlyBillingService]
- **S36.R-46** With no payload the job MUST bill the last closed hour, an explicit hour less than 5 minutes closed MUST be refused with `hour_not_closed` writing nothing, and a campaign without aggregates MUST get no run. [proof: S36 AS-56] [code: packages/backend/libs/domains/marketing/application/hourly-billing.service.ts#HourlyBillingService]
- **S36.R-47** The reconciliation MUST recompute each campaign-hour of the last three closed days from the raw log with the cap applied in hour order and post the difference as one numbered `ADJUSTMENT` (refund or extra charge), posting nothing for a zero delta or a second run. [proof: S36 AS-58, S36 AS-59, S36 AS-61, S36 AS-67] [code: packages/backend/libs/domains/marketing/application/reconciliation.service.ts#ReconciliationService]
- **S36.R-48** An hour with raw clicks and no billing run MUST be charged by the reconciliation with the reference the hourly job uses, and the hourly job then posts nothing. [proof: S36 AS-60] [code: packages/backend/libs/domains/marketing/application/reconciliation.service.ts#ReconciliationService]
- **S36.R-49** A closed day MUST never be rewritten: a later correction is an adjustment dated at its posting time that names the original hour, a day outside the window is processed only when asked, and two reconciliations of one day do the work once. [proof: S36 AS-62, S36 AS-63] [code: packages/backend/libs/domains/marketing/infra/sequelize-billing.store.ts#SequelizeBillingStore]
- **S36.R-50** A raw log that cannot be read MUST record the run `FAILED` (`source_unavailable`), move no money and let the next run process the day. [proof: S36 AS-64] [code: packages/backend/libs/domains/marketing/application/reconciliation.service.ts#ReconciliationService]
- **S36.R-51** A day whose drift exceeds 1% of the exact clicks MUST set `ads_reconciliation_drift_ratio{day}` and log a warning; at or below 1% no warning. [proof: S36 AS-65] [code: packages/backend/libs/domains/marketing/domain/ads-metrics.ts#adsReconciliationDriftGauge]
- **S36.R-52** Only valid distinct clicks received within the UTC day MUST count, the boundary belonging to the day it falls in. [proof: S36 AS-66] [code: packages/backend/libs/domains/marketing/infra/clickhouse-ad.reader.ts#ClickhouseAdReader]
- **S36.R-53** The statement MUST list each billed hour newest first with state, source, clicks, billable and capped clicks, amount, adjustments and net amount, keyset-paged, for `payouts.read` members of the owning shop, range at most 92 days. [proof: S36 AS-68] [code: packages/backend/libs/domains/marketing/application/billing-statement.service.ts#BillingStatementService]
- **S36.R-54** The statement's net amounts MUST add up to the movement of the shop's ledger account for the campaign's references. [proof: S36 AS-69] [code: packages/backend/libs/domains/marketing/application/billing-statement.service.ts#BillingStatementService]
- **S36.R-55** The product read model MUST be a version-guarded upsert of `products.events`: a late or repeated version has no effect and an invalid payload is dead-lettered while the consumer continues. [proof: S36 AS-70] [code: packages/backend/libs/domains/marketing/infra/product-snapshot.projector.ts#AdsProductSnapshotProjector]
- **S36.R-56** An archived product MUST pause its campaign (`product_unavailable`), a restore MUST never resume it, a delete MUST end it and an out-of-stock product MUST only stop being served. [proof: S36 AS-71] [code: packages/backend/libs/domains/marketing/application/snapshot-effects.service.ts#SnapshotEffectsService]
- **S36.R-57** A resume MUST be refused with `409` `product_unavailable` or `shop_inactive` while the product or shop is not available, changing nothing. [proof: S36 AS-72] [code: packages/backend/libs/domains/marketing/application/campaign-command.service.ts#CampaignCommandService]
- **S36.R-58** A suspended or offboarding shop MUST not be served, a deleted shop's campaigns MUST end with their billing records kept, and a late, repeated or invalid shop event MUST have no effect. [proof: S36 AS-73] [code: packages/backend/libs/domains/marketing/infra/shop-snapshot.projector.ts#AdsShopSnapshotProjector]
- **S36.R-59** A campaign MUST be served at once from the product and shop read models seeded at creation by the R1 lookups, and an older event arriving later MUST be ignored. [proof: S36 AS-74] [code: packages/backend/libs/domains/marketing/infra/catalog.adapter.ts#CatalogAdapter]
- **S36.R-60** Every campaign and sponsorship event MUST parse with its contract schema and carry the envelope, and a create whose transaction fails MUST leave no row and no event. [proof: S36 AS-75] [code: packages/backend/libs/domains/marketing/application/events/ads-events.ts#CampaignCreated]
- **S36.R-61** The metrics `ads_impressions_total`, `ads_clicks_total`, `ads_late_clicks_total`, `ads_aggregator_batches_total`, `ads_aggregator_fenced_total`, `ads_billing_charged_minor_total`, `ads_billing_adjustment_minor_total`, `ads_billing_orphan_aggregate_total`, `ads_billing_lag_seconds`, `ads_reconciliation_runs_total` and `ads_reconciliation_drift_ratio` MUST exist with bounded labels and no campaign, shop, token or address value. [proof: S36 AS-76] [code: packages/backend/libs/domains/marketing/domain/ads-metrics.ts#adsClicksCounter]
- **S36.R-62** Startup MUST fail naming the key for a missing or short click secret, one equal to another secret, a previous secret equal to the current, a threshold that is not a positive integer or a missing worker slot name, and never fall back to another secret. [proof: S36 AS-77] [code: packages/backend/libs/common/config/ads-config.ts#adsConfigKeys]
- **S36.R-63** Every error MUST be problem+json with a stable code and a request id, and a `5xx` MUST carry a generic detail. [proof: S36 AS-78] [code: packages/backend/libs/domains/marketing/domain/ads-errors.ts#AdsError]
- **S36.R-64** No log line of serve, click and bill MUST hold a click token, a signing secret, a raw address or a request body. [proof: S36 AS-79] [code: packages/backend/libs/domains/marketing/application/click.service.ts#ClickService]
- **S36.R-65** The capability's tables MUST be in the ownership registry, hold no foreign key to another owner's table, and the barrel MUST export only modules and event definitions of the ads half. [proof: S36 AS-80] [code: packages/backend/libs/domains/marketing/index.ts#AdsModule]
- **S36.R-66** The migrations MUST run up, down and up again with a lock timeout, rename or drop nothing running code reads, and drop the cross-owner foreign keys in their own step. [proof: S36 AS-81] [code: packages/backend/migrations/20261013150000-ads-campaigns-v2.js#module]
- **S36.R-67** A stop in the middle of an aggregator batch MUST leave no open transaction, the batch MUST be processed exactly once after the restart, and a start that fails MUST fail the start. [proof: S36 AS-82] [code: packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#ClickAggregator]

## Behaviors
- **S36.B-01** Given a seller who creates a campaign for a product, when a shopper asks for slots and clicks the card, then the shopper lands on the product page and one valid click is recorded. [proof: S36 AS-26]
- **S36.B-02** Given the same sponsored link clicked twenty times at once, then every click lands on the product and exactly one is counted. [proof: S36 AS-28]
- **S36.B-03** Given the counting infrastructure down, when a shopper clicks a sponsored card, then they still land on the product. [proof: S36 AS-35]
- **S36.B-04** Given an hour with 20 clicks of which only 10 fit the budget, then the shop is charged for 10 and the other 10 are recorded as capped. [proof: S36 AS-53]
- **S36.B-05** Given a billed hour that the raw log says was over-counted, then the next reconciliation refunds the difference without changing the closed day. [proof: S36 AS-58]
- **S36.B-06** Given a product that is archived, then its campaign pauses, is no longer served and does not resume when the product returns. [proof: S36 AS-71]

## Lifecycles
A campaign is `ACTIVE`, `PAUSED` (by the seller or because its product became unavailable) or `ENDED` (final). A billing run is `PENDING` until its ledger journal is posted, then `CHARGED`; an adjustment is `PENDING` then `POSTED`; a reconciliation run is `RUNNING`, then `COMPLETED` or `FAILED`. A closed UTC day is never updated: later corrections are new adjustments dated at their posting time.

## Owns
- PostgreSQL tables `AdCampaign`, `AdCampaignHistory`, `AdProductSponsorship`, `AdShopQuota`, `AdProductSnapshot`, `AdShopSnapshot`, `AdBillingRun`, `AdBillingAdjustment` and `AdReconciliationRun`.
- Redis keys `adclick:*`, `adspam:*` and `adspend:*`; topics `ads.clicks`, `ads.click-aggregates`, `ads.clicks.dlq` and `marketing.events`; ClickHouse tables `ad_clicks_log` and `ad_click_minute_v2`.
- Rate-limit policies `marketing.ads-write.shop`, `marketing.ads-read.shop` and `marketing.ads-serve.ip`; jobs `ads.bill-hour` and `ads.reconcile-day`.
- Configuration keys `ads_click_secret`, `ads_click_secret_previous`, `ads_spam_ip_per_minute`, `ads_spam_repeat_per_hour` and `ads_aggregator_instance`.

## Decisions
- The click endpoint is a `GET` that records a click, an accepted exception to the "GET changes no state" rule; it is made safe by the per-impression marker, `no-store`, `HEAD` and prefetch not counting and the spam filter.
- A charge is posted by three separate units of work (marketing run row, ledger-only journal, marketing state update) that converge on the ledger reference, because one transaction must not write two owners.
- The speed path may count a click twice when its duplicate lands in another batch; the reconciliation corrects it with the raw log, which is the source of truth for billing.
- The stores are plain SQL on the tables the capability owns, like the other recent domains, with no Sequelize model.

## Known gaps
- The capacity and latency criteria (SC-002, SC-005 latency, SC-007 alert routing, SC-008 and SC-009 at the 99th percentile) and the UI journeys have no automated proof (listed in `specs/UNVERIFIED.md`).
- A reconciliation gauge series per day is never removed, so the label set grows by one day per day.
- The web screens belong to W02 and W04.
