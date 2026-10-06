# Questions and defaults: S36 — Sponsored listings

Nothing was asked; each line is a default already applied in `spec.md`. Sorted by impact: BREAKING first (changes a behaviour or contract that exists today, so the implementation updates existing tests and callers), then CONTRACT (another capability must provide or consume it), then LOCAL.

## BREAKING

- [BREAKING] Money fields (`cpcCents`, `dailyBudgetCents`, raw rows returned by `createCampaign`) → `cpcMinor`, `dailyBudgetMinor`, `currency: 'EUR'`, a response DTO (`adCampaignSchema`), range checks (CPC 1–10,000, budget 100–10,000,000, budget ≥ CPC) → III.8 and V.1 (no raw rows, one money naming); `ads.service.ts:40-47`, `ads.controller.ts:13-18`, `ads.e2e-spec.ts:62-66`.
- [BREAKING] Create request no longer takes `category`; it is copied from the product → a seller could tag a product with any category and win slots in the wrong one; `ads.controller.ts:15`, `ads.service.ts:42`.
- [BREAKING] Mutations need `shop.manage` (OWNER, ADMIN) instead of `products.write` (STAFF could spend); reads `products.read`; statement `payouts.read` → money-spending actions need the stronger role; S03 matrix (FR-020); `ads.controller.ts:25`.
- [BREAKING] `GET /ads/sponsored` returns `{items, generatedAt}` with `limit`, `Cache-Control: private, no-store`, drops the `viewer` field, validates `category`, and `category=all` means every category (today `all` matches only campaigns whose category is literally `all`) → a shared cache would replay one impression ID to many shoppers and starve billing; `ads.controller.ts:34`, `ads.service.ts:50-67`.
- [BREAKING] Click token: dedicated secret `ads_click_secret` (+ `_previous`) instead of `share_link_secret || jwt_secret`; full-length HMAC instead of 32 characters; claims gain a viewer hash and a key ID, validated by schema; tokens in flight at deploy (≤ 30 min) become invalid and redirect home → domain separation of secrets, rotation, constant-time check; `ads.service.ts:37`, `domain/click-token.ts:19-28`.
- [BREAKING] Client address comes only from trusted-proxy resolution; `cf-connecting-ip` is no longer trusted → a forged header lets one machine defeat the burst filter; `ads.controller.ts:41`.
- [BREAKING] The click endpoint never returns an error status: Redis or stream failure still redirects (today a Redis error is an unhandled `500` with no redirect), and a click that cannot be vetted is recorded invalid `filter_unavailable` → the shopper must land on the product; under-billing beats over-billing; `ads.service.ts:73-90`.
- [BREAKING] `HEAD` and prefetch requests to the click URL no longer count or consume the impression → link scanners and browser prefetch would otherwise create billable clicks; `ads.controller.ts:38-45`.
- [BREAKING] Click record on `ads.clicks` gains `product_id`, `viewer_hash`, `invalid_reason`, and `ts` becomes `received_at`; the analytics DDL (`clickhouse/080_ads.sql`) and the aggregator read the new shape, validated by `adClickRecordSchema` in `packages/contracts` → V.2, evidence for disputes.
- [BREAKING] Hot-key salt is a deterministic function of the click ID, not `Math.random()` → a retried click lands on the same partition and replays are reproducible; `ads.service.ts:84`.
- [BREAKING] Aggregator: stable transactional identity per instance (today `hostname-pid`, so a restarted zombie is never fenced), in-batch dedupe by click ID, zod validation and dead-lettering instead of silently dropping unparseable messages → P0603 fencing; VII.4; `click-aggregator.service.ts:52,70-76`.
- [BREAKING] Billing charges whole clicks only (`floor(remaining / CPC)`), where today a capped hour charges the leftover fraction `min(clicks × cpc, remaining)` → the shop is never charged a price it did not agree to; `ad-billing.jobs.ts:92`.
- [BREAKING] Ledger posting leaves the shop's DB transaction: a `PENDING → CHARGED` run plus a ledger-only transaction keyed by reference `ad:<campaignId>:<hour>` (today one Postgres transaction writes `AdBillingRun` and the ledger tables) → IX.4 forbids one transaction writing two owners; idempotency by reference converges after a crash in either order; `ad-billing.jobs.ts:84-103`. Adds a `state` column to `AdBillingRun`.
- [BREAKING] Reconciliation: window of the last 3 closed days with a numbered adjustment per campaign-hour, late clicks become adjustments in the current period (today a run is reconciled once, `reconciledClicks IS NULL`, and later clicks are ignored forever); `AdBillingAdjustment` and `AdReconciliationRun` tables replace `reconciledClicks` / `adjustmentJournalId` → period close per the notes: closed periods never mutate, corrections go to the current one; `ad-billing.jobs.ts:56-81,105-122`.
- [BREAKING] Serving reads two read models (product, shop) fed by events instead of `JOIN "Product"`; `AdCampaign` loses its foreign keys to `Shop` and `Product` (IX.4); staleness ≤ 60 s → D-7/D-12; `ads.service.ts:42-43,50-56`, `migrations/20261001330000-sponsored-ads.js:12-13`.
- [BREAKING] One non-ended campaign per product, at most 50 per shop, one slot per shop per response; lifecycle endpoints `pause|resume|end`, list, read, statement are new (today `PAUSED` is unreachable) → invariants enforced by constraint; additive endpoints.
- [BREAKING] `ads.e2e-spec.ts` is replaced by six feature files (see `test-plan.md`); its trending case belongs to S35; its `createCampaign`, `ads.click`, `billHour`, `reconcileDay`, `LedgerService.balance`, `ShopModel` and `TrendingConsumer` imports go; `AdsWorkerModule` splits into worker and projector modules → VII.2/VII.8, X.4, no cross-domain model access.
- [BREAKING] `GET /ads/click/:token` stays a state-changing `GET` redirect, an explicit exception to constitution V.5 → the notes' design is a redirect click service ("click service (redirect + log, fast)"); mitigations: idempotent per impression, `no-store`, `HEAD`/prefetch ignored, spam filter. Record in `plan.md` Complexity Tracking. The alternative (a `POST` beacon) loses clicks from clients that block scripts and is not what the notes describe.

## CONTRACT

- [CONTRACT] S14 `postJournal` use → kinds `AD_CHARGE` (reference `ad:<campaignId>:<YYYY-MM-DDTHH>`) and `ADJUSTMENT` (reference `ad-adj:<campaignId>:<YYYY-MM-DDTHH>:<sequence>`), currency `EUR`, shop line negative for a charge, the caller's transaction contains only ledger writes → S14's example reference was `campaignId:hour`; adjustments need a sequence because several can exist per hour.
- [CONTRACT] S14 hot accounts → ad charges credit `PLATFORM_FEES` (a hot, sharded account in S14), at most one posting per campaign-hour (≈ 1 per campaign per hour) → no extra hot-spot beyond what S14 sizes for.
- [CONTRACT] S32 sponsorship signal → `marketing.product_sponsorship_changed v1 {productId, shopId, sponsored, sponsorshipVersion}` on topic `marketing.events`, key `productId`, emitted only on a change of value → S32 proposed the name and left the topic open; versions let S32 ignore stale events.
- [CONTRACT] S05 → R1 `getProductsByIds(ids, {shopId})` at creation only; R3 from `catalog.product_*` for serving; fields used `title, category, inStock, status, isSandbox, productVersion` → no `Product` SQL.
- [CONTRACT] S03 → events `tenancy.shop_status_changed`, `shop_offboarding_started`, `shop_deleted`, guarded by `shopVersion`; `ShopScoped` with `shop.manage`, `products.read`, `payouts.read`; no new ads permission → avoids a cross-capability change to S03's matrix.
- [CONTRACT] S50 → three policies (`marketing.ads-write.shop`, `marketing.ads-read.shop`, `marketing.ads-serve.ip`); the click endpoint has none → a limiter must never cost the shopper the redirect.
- [CONTRACT] S49 → jobs `ads.bill-hour`, `ads.reconcile-day` single-run across replicas.
- [CONTRACT] S53 → outbox `append` for campaign events, the idempotent versioned consumer framework with dead-letter handling for the two read-model consumers and the aggregator; the transactional producer/consumer client for the aggregator.
- [CONTRACT] S54 → trusted-proxy client-address resolution; config validation incl. secret separation; metrics registry.
- [CONTRACT] W02/S48 (sponsored card) → render "Sponsored", use `clickUrl` verbatim, never cache or prefetch it, forward the viewer identity through the BFF (R2), degrade to no ads on `items: []`, `429`, `503`; UI journey proposed for `packages/web/tests/sponsored-listing.spec.ts` → no web owner exists yet.
- [CONTRACT] W04 (campaign management) → create, pause, resume, end, list, statement screens; UI journey proposed for `packages/web/tests/ad-campaign.spec.ts` → no web owner exists yet.
- [CONTRACT] S34 → sponsored slots are offered only by `GET /ads/sponsored`; S36 does not re-rank recommendation rails.
- [CONTRACT] S10 → S10 lists S36 as a consumer of order events "for conversion"; not provided here (no conversion attribution, the notes do not ask for it); S10 may drop that consumer.
- [CONTRACT] S37 → share links stay in `marketing` but are a separate capability and module; nothing in this spec changes them; `ShareLinksModule` and `LinkClicksProjector` stay out of S36's barrel changes.
- [CONTRACT] Topic and table ownership → `ads.clicks`, `ads.click-aggregates` and the analytics tables `ad_clicks_raw`, `ad_click_minute` are owned by `marketing`; the new Postgres tables (`AdCampaignHistory`, `AdProductSponsorship`, `AdProductSnapshot`, `AdShopSnapshot`, `AdBillingAdjustment`, `AdReconciliationRun`) are added to `db/ownership.ts` as `domain:marketing`.

## LOCAL

- [LOCAL] Token lifetime 30 min; dedupe marker lifetime ≥ token lifetime + 5 min → covers clock skew.
- [LOCAL] Spam thresholds 20/min per address, 3/hour per address-or-viewer per campaign; fixed UTC windows; both configurable → simple, exact counters.
- [LOCAL] Spam precedence `ip_burst` over `repeat_clicker` → one reason per click.
- [LOCAL] CPC and budget cannot be edited → price per click stays unambiguous.
- [LOCAL] Raw log verdict on duplicate click ID: first recorded wins → deterministic.
- [LOCAL] Reconciliation window 3 days; raw retention 400 days → catches late data; billing evidence.
- [LOCAL] Drift alert threshold 1% → matches the "batch is the truth" check.
- [LOCAL] Late-event allowance 2 minutes (metric only) → from the notes; lateness never loses a click.
- [LOCAL] Product archive pauses, restore does not resume, delete ends → no surprise spending.
- [LOCAL] Click publish timeout 1 s; dedupe/filter store timeout 100 ms → redirect latency stays within SC-002.
- [LOCAL] Statement range at most 92 days → bounded reads.
- [LOCAL] Per-shop active campaign limit 50 → bounds the serving candidate set.
- [LOCAL] Candidate set for one serving request ≤ 50 campaigns per category before the one-per-shop cut → bounded work.
