# Feature Specification: S36 — Sponsored Listings (signed click tokens, exact dedupe, click-spam filter, reconciled billing)

**Feature Branch**: none (spec directory `specs/domains/S36-sponsored-listings`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S36 of `scripts/sdd/capabilities.tsv` (domain `marketing`). Sources: `docs/showcase/sections/SD-32-trending-sponsored-clicks.md` (sponsored half only) and `10-System-Design/09-data-and-infrastructure.md` §32 (Interview-Prep; the notes win over the code), plus `06-Distributed-Systems/01` §2.2 (Kafka transactions) and `06-Distributed-Systems/02` §5 (reconciliation and period close). Pattern rows served: **P0603** (idempotent producer, transactions, exactly-once inside the event stream) and **P0614** (reconciliation and period close, ad billing).

## Scope

**In scope** (everything a shop and a shopper can observe of sponsored listings, and everything that turns a click into money):

- Campaigns: a shop sponsors one of its products at a price per click (CPC) with a daily budget; pause, resume, end; list and read; the sponsorship signal other capabilities consume.
- Serving: up to 3 labelled sponsored slots per request, each carrying a **signed, expiring click token** that identifies one served impression.
- Clicks: verify the token, count each impression **at most once**, filter click spam, record the click, and **always** redirect the shopper to the product.
- Counting: a transactional streaming aggregator (per-campaign, per-minute, hot-key salted) and a raw, deduplicated click log.
- Billing: an hourly charge from the streaming aggregates, capped by the daily budget, posted once to the ledger; a daily **reconciliation** that recomputes from raw deduplicated clicks and posts adjustments; period close.
- The advertiser's billing statement.
- The read models this capability needs from other domains (product and shop state) and the signals it emits.

**Out of scope** (owned elsewhere; named so nothing is built twice):

- Share and affiliate short links and their click attribution → **S37** (same domain `marketing`, separate module; the share-link click path and `LinkClicksProjector` are not touched here).
- Trending products (approximate, never feeds money) → **S35**. Nothing is shared with it: no sketch, window class, or topic.
- Search ranking and the sponsored label inside search results → **S32** (this capability only publishes the sponsorship signal). Sponsored slots inside recommendation rails → **S34** consumes the slots endpoint; re-ranking is not offered here.
- The ledger itself (accounts, journals, balances) → **S14**. Job scheduling → **S49**. Rate limiter → **S50**. Outbox, consumer framework, dead-letter handling → **S53**. Problem+json, clock, config, metrics, shutdown → **S54**.
- Web screens (sponsored card, campaign management) → **W02**, **W04** (see Cross-capability contracts).
- Conversion attribution (purchase after an ad click), campaign editing (changing CPC or budget; the seller ends and recreates), targeting beyond product category, impression-based pricing, second-price auctions, advertiser prepaid balances and invoices.

**Pattern coverage** (every row of `pattern-map.md` that lists S36 must appear as requirements and scenarios):

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0603 Idempotent producer, Kafka transactions | FR-030 – FR-039 (idempotent click record, transactional read-process-write, fencing, replay-safe sink, salting) | AS-26 – AS-28, AS-34, AS-37, AS-42 – AS-47 |
| P0614 Reconciliation and period close (ad billing) | FR-040 – FR-059 (hourly charge, budget cap, reconciliation, adjustments in the current period, closed periods never mutated) | AS-50 – AS-67, AS-69 |

## User Scenarios & Testing *(mandatory)*

**Notation.** Money is integer minor units in `EUR` (`25` = 0.25 EUR). Shops `A` and `B`; users: `OA` (owner of A), `AA` (admin of A), `SA` (staff of A), `VA` (viewer of A), `OB` (owner of B), `ANON` (no credentials). Products `PA1`, `PA2` (shop A, `ACTIVE`, in stock, category `audio`) and `PB1` (shop B). `T` is the frozen clock. A **campaign** is `ACTIVE`, `PAUSED` or `ENDED`. A **click token** is the opaque string inside a `clickUrl`. "Counted" means the click is recorded as valid and is billable; "recorded invalid" means it is kept as evidence and never billed. `front` is the configured storefront origin. All error bodies are problem+json with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`.

### User Story 1 — A shop sponsors a product and controls the campaign (Priority: P1)

A shop member with the right role picks one of the shop's products, sets a price per click and a daily budget, and the product becomes eligible for sponsored slots. They can pause, resume or end the campaign, and list and read their campaigns. No other shop can see or touch them.

**Why this priority**: no campaign, no ads, no revenue; and every mutation spends or stops money.

**Independent Test**: call the campaign endpoints as each role and as another shop; assert responses, stored rows and the events in the outbox.

**Acceptance Scenarios**:

1. **AS-01** (create, happy path) — **Given** `PA1` (`ACTIVE`, in stock, category `audio`) and no campaign for it, **When** `OA` calls `POST /shops/A/ads/campaigns {productId: PA1, cpcMinor: 25, dailyBudgetMinor: 1000}`, **Then** `201`, the body parses with `adCampaignSchema`: `{id, shopId: A, productId: PA1, category: "audio" (copied from the product), cpcMinor: 25, dailyBudgetMinor: 1000, currency: "EUR", status: "ACTIVE", statusReason: null, campaignVersion: 1, createdAt: T, updatedAt: T}`; one campaign row, one status-history row and the outbox events `marketing.campaign_created` and `marketing.product_sponsorship_changed {productId: PA1, shopId: A, sponsored: true, sponsorshipVersion: 1}` exist, all committed together.
2. **AS-02** (validation classes) — **Given** `OA`, **When** the body is each of: no `productId`; `productId` not a UUID; `cpcMinor` missing, `0`, `-1`, `12.5`, `"25"`, `10001`; `dailyBudgetMinor` missing, `99`, `12.5`, `10000001`; an unknown property (`category`, `currency`, `status`); **Then** each answers `400 validation_failed` with the offending field named and nothing is written; **When** `cpcMinor: 500` and `dailyBudgetMinor: 400`, **Then** `422 budget_below_cpc` and nothing is written.
3. **AS-03** (authentication and roles) — **Given** the permission matrix of S03 (`shop.manage` for create, pause, resume, end; `products.read` for list and read; `payouts.read` for the billing statement), **When** each call is made without credentials, **Then** `401`; as `VA` and `SA` a mutation answers `403 permission_denied`; as `AA` and `OA` it succeeds; `VA` can list and read but not read the statement (`403`); no row changes on a refusal.
4. **AS-04** (cross-tenant, IDOR) — **Given** a campaign `CB` of shop B, **When** `OA` calls `GET`, `POST …/pause`, `POST …/end` or `GET …/billing` for `CB` under `/shops/A/…`, **Then** `404 campaign_not_found` for each, with the same body as for an unknown ID; **When** `OA` calls any endpoint under `/shops/B/…`, **Then** `404 shop_not_found`; **When** `OA` creates a campaign in shop A for `PB1`, **Then** `404 product_not_found` (same body as an unknown product); nothing changes and no event is published.
5. **AS-05** (product eligibility) — **Given** products that are archived, sandbox, deleted/unknown, and out of stock, **When** `OA` creates a campaign for each, **Then** archived and sandbox answer `422 product_not_sponsorable`, unknown answers `404 product_not_found`, and the out-of-stock product answers `201` (it is simply not served until it is back in stock, AS-18).
6. **AS-06** (one open campaign per product) — **Given** an `ACTIVE` or `PAUSED` campaign for `PA1`, **When** a second create for `PA1` arrives, **Then** `409 campaign_already_exists` and no second row; after the first is `ENDED` a create succeeds; **When** two creates for `PA2` race (`Promise.all`), **Then** exactly one `201` and one `409`, one row, one `product_sponsorship_changed`.
7. **AS-07** (per-shop limit) — **Given** shop A has 50 non-ended campaigns, **When** a 51st is created, **Then** `422 campaign_limit_reached`; **Given** 49, **When** two creates race, **Then** exactly one `201` and one `422`, and the count is 50.
8. **AS-08** (pause, resume, end) — **Given** an `ACTIVE` campaign (version 1), **When** `POST …/pause`, **Then** `200`, `status: PAUSED`, `statusReason: "seller"`, `campaignVersion: 2`, outbox `marketing.campaign_paused` and `product_sponsorship_changed {sponsored: false, sponsorshipVersion: 2}`; **When** `POST …/resume`, **Then** `ACTIVE`, version 3, `marketing.campaign_resumed`, `{sponsored: true, sponsorshipVersion: 3}`; **When** `POST …/end`, **Then** `ENDED`, version 4, `marketing.campaign_ended`, `{sponsored: false, sponsorshipVersion: 4}`; each change has a history row (who, from, to, when) written in the same transaction as the row and the events.
9. **AS-09** (illegal transitions) — **Given** a `PAUSED` campaign, **When** `pause` is called; **Given** an `ACTIVE` one, **When** `resume` is called; **Given** an `ENDED` one, **When** any of `pause`, `resume`, `end` is called, **Then** each answers `409 invalid_transition` naming `from` and the requested action; nothing changes, no event is published.
10. **AS-10** (concurrent transitions) — **Given** an `ACTIVE` campaign, **When** two `pause` requests race, **Then** exactly one `200` and one `409`, one history row, one `campaign_paused` event; the same holds for two `end` requests.
11. **AS-11** (sponsorship signal only on a change of value) — **Given** a `PAUSED` campaign (sponsored already `false`, `sponsorshipVersion: 2`), **When** it is ended, **Then** `marketing.campaign_ended` is published and **no** `product_sponsorship_changed` is (the value did not change, the version stays 2).
12. **AS-12** (list) — **Given** 5 campaigns of shop A and 1 of shop B, **When** `GET /shops/A/ads/campaigns?limit=2` is called as `VA`, **Then** `200 adCampaignPageSchema {items: 2, nextCursor}` ordered by `createdAt` descending then `id` descending; following the opaque cursor yields all 5 once and none of B's; `status=ACTIVE` filters; `limit=0`, `limit=101`, `status=FOO` and a tampered cursor answer `400` (`validation_failed`, `invalid_cursor`).
13. **AS-13** (read one) — **Given** a campaign with `1000` billed today, **When** `GET /shops/A/ads/campaigns/:id`, **Then** `200 adCampaignSchema` plus `billedTodayMinor: 1000` (charges posted so far in the current UTC day; never an estimate).
14. **AS-14** (write rate limit) — **Given** policy `marketing.ads-write.shop` (60 per minute per shop, fail closed), **When** the 61st mutation of shop A arrives within the minute, **Then** `429 rate_limited` with `Retry-After`, nothing written; **When** the limiter's store is down, **Then** the mutation is refused with `503` (fail closed) and nothing is written.
15. **AS-15** (state machine, pure) — **Given** the transition function over `(status, action)`, **Then**, table-driven over all 3 × 3 pairs: `ACTIVE`+pause → `PAUSED`; `PAUSED`+resume → `ACTIVE`; `ACTIVE`/`PAUSED`+end → `ENDED`; every other pair is illegal; `ENDED` has no outgoing transition; the sponsored value is `true` only for `ACTIVE`.

### User Story 2 — Shoppers see clearly labelled sponsored slots (Priority: P1)

A shopper (signed in or not) asks for sponsored slots in a category and receives up to three eligible products, each marked as sponsored and carrying a click URL that is valid for 30 minutes and can pay for at most one click.

**Why this priority**: it mints the tokens that make every later billing guarantee possible.

**Independent Test**: seed campaigns, products and read models; call `GET /ads/sponsored`; verify the tokens with the signer; assert nothing about price or budget leaks.

**Acceptance Scenarios**:

1. **AS-16** (serving, happy path) — **Given** three eligible campaigns in category `audio` from three shops with CPC `30`, `20`, `10`, **When** `ANON` calls `GET /ads/sponsored?category=audio`, **Then** `200`, `Cache-Control: private, no-store`, the body parses with `sponsoredSlotsResponseSchema {items, generatedAt: T}`: three items in the order CPC `30`, `20`, `10`, each `{campaignId, productId, shopId, title, priceMinor, currency, sponsored: true, clickUrl: "/api/ads/click/<token>", expiresAt: T + 30 min}`; the tokens verify and name the campaign, shop, product and an impression ID; the body contains no CPC, budget or viewer identifier; `ads_impressions_total{result="served"}` rises by 3.
2. **AS-17** (category semantics and validation) — **Given** campaigns in `audio` and `video`, **When** `category=all` or no category, **Then** items from both categories; **When** `category=garden` (no campaigns), **Then** `200 {items: []}`; **When** the category is `Audio`, contains a space, or is 41 characters, **Then** `400 validation_failed`.
3. **AS-18** (eligibility filters, table-driven) — **Given** one otherwise eligible campaign, **When** each of the following holds, **Then** it is **not** served: the campaign is `PAUSED` or `ENDED`; its product read model says archived, out of stock or sandbox; its shop read model says the shop is not `ACTIVE`; there is no product read model yet; today's spend plus one click would exceed the daily budget; and it **is** served again when the condition is reversed (stock back, shop reinstated).
4. **AS-19** (diversity, limit, tie-break) — **Given** two eligible campaigns of the same shop (CPC `40`, `35`) and two of other shops (CPC `30`, `30`), **When** the slots are requested, **Then** at most one slot per shop (`40`, then the `30`s); equal CPC is ordered by `campaignId` ascending (identical result on every call); `limit=1` returns one item; `limit=0` and `limit=4` answer `400`.
5. **AS-20** (fresh token per response, no personal data in it) — **Given** the same viewer, **When** two requests are made, **Then** the two responses carry different tokens (different impression IDs), each valid; **Given** a signed-in viewer and an `X-Anonymous-Id`, **Then** the token's readable claims hold no user ID, anonymous ID or address, only a keyed one-way viewer hash.
6. **AS-21** (degradation) — **Given** the store that holds today's spend counters is down or slower than its timeout, **When** slots are requested, **Then** `200 {items: []}` (never serve what cannot be budget-checked), `ads_impressions_total{result="degraded"}` increments; **Given** the database is down, **Then** `503 service_unavailable` with a generic `detail`.
7. **AS-22** (serving rate limit) — **Given** policy `marketing.ads-serve.ip` (120 per minute per address, fail open), **When** the 121st request arrives, **Then** `429 rate_limited`; **When** the limiter's store is down, **Then** requests are served.
8. **AS-23** (ranking, pure) — **Given** the selection function over `(candidates: {campaignId, shopId, cpcMinor}[], limit)`, **Then**, table-driven and as a property: result length ≤ `limit`; at most one per shop; sorted by CPC descending then `campaignId` ascending; the same input in any order gives the same output; the best-CPC candidate of each shop is the one kept.

### User Story 3 — A click is counted once, and the shopper always lands on the product (Priority: P1)

The shopper clicks a sponsored card. The platform checks that it served that exact impression, makes sure the impression is billed at most once, records the click, and redirects. Whatever goes wrong behind the scenes, the shopper still arrives at the product (or the storefront home for an invalid link).

**Why this priority**: it is the money event; forged, replayed or lost clicks are the whole risk.

**Independent Test**: serve a slot, click it through HTTP with every kind of token, and assert the redirect, the recorded click and the metrics.

**Acceptance Scenarios**:

1. **AS-24** (token, pure) — **Given** the signer and verifier over `(claims, secret, now)`, **Then**, table-driven: a valid token verifies and returns its claims; expired at exactly `exp` (`now ≥ exp` is expired) and after; one flipped character anywhere in payload or signature fails; a truncated or lengthened signature fails without throwing; extra or missing segments, empty string, non-base64 and non-JSON payload fail; a payload whose claims have the wrong shape (missing impression ID, non-UUID, non-integer expiry) fails even with a correct signature; a token signed with a different secret fails; verification never throws and compares signatures in constant time; as a property: for any claims `verify(sign(c)) = c` before expiry, and any single-character mutation fails.
2. **AS-25** (key rotation) — **Given** a current and a previous signing secret, **When** a token signed with the previous secret is clicked, **Then** it verifies (counted); **When** the previous secret is removed from configuration, **Then** the same token is treated as invalid (AS-29); newly minted tokens always use the current secret and carry its key ID.
3. **AS-26** (click, happy path) — **Given** a served slot of campaign `C` (product `PA1`) and `T`, **When** `GET /ads/click/<token>` arrives from address `X`, **Then** `302` with `Location: front/p/PA1?ad=1`, `Cache-Control: no-store`; exactly one record is published to `ads.clicks` `{click_id: <impression ID>, campaign_id: C, shop_id: A, product_id: PA1, received_at: T, ip_hash, viewer_hash, valid: 1, invalid_reason: null}` with a salted key `C#<0-9>`; the dedupe marker for the impression exists with a lifetime of at least token lifetime plus 5 minutes; `ads_clicks_total{outcome="counted"}` is 1; no raw address is stored in any record, key, metric or log line.
3. **AS-27** (duplicate click, sequential) — **Given** AS-26, **When** the same token is clicked again, from any address, **Then** `302` to the same `Location`; no record is published; `ads_clicks_total{outcome="duplicate"}` is 1.
4. **AS-28** (duplicate click, concurrent) — **Given** one served token, **When** 20 requests with it arrive at once (`Promise.all`), **Then** all 20 answer `302` to the same `Location`, exactly one record is published, `counted` is 1 and `duplicate` is 19.
5. **AS-29** (invalid, forged, expired, oversized) — **Given** each of: a token with a forged signature; a payload altered after signing; a correctly signed but expired token (`T + 30 min + 1 s`); garbage; an empty-looking token (`/ads/click/x`); a token longer than 2,048 characters; a token signed with an unknown secret, **When** clicked, **Then** every one answers `302` to `front/` (the storefront root, never an error page), nothing is published, no marker is created, and `ads_clicks_total{outcome="invalid_token"}` (or `expired` for the expired one) rises.
6. **AS-30** (no open redirect) — **Given** a valid token, **When** the request adds `?redirect=https://evil.example`, `?next=//evil.example`, or a spoofed `Host` or `X-Forwarded-Host`, **Then** `Location` is still exactly `front/p/PA1?ad=1`; the target is built only from the configured storefront origin and the signed product ID.
7. **AS-31** (requests that are not clicks) — **Given** a valid token, **When** the request is `HEAD`, or carries `Sec-Purpose: prefetch` or `Purpose: prefetch`, **Then** it answers the redirect, publishes nothing and does **not** consume the impression; a later real `GET` is counted.
8. **AS-32** (trusted client address) — **Given** the service is not behind a configured trusted proxy, **When** 30 clicks with 30 valid tokens each carry a different forged `CF-Connecting-IP` / `X-Forwarded-For`, **Then** they all count as one address (the socket's) and the spam filter applies (AS-38); **Given** a configured trusted proxy, **Then** the forwarded address it supplies is used.
9. **AS-33** (a click on an impression already served is billable) — **Given** a token served for `C`, **When** `C` is paused (or ended) and then the token is clicked before it expires, **Then** `302` and the click is recorded `valid: 1` (the impression was served while eligible); the daily budget cap still bounds the charge (AS-53).
10. **AS-34** (recording fails) — **Given** the event stream is down or the publish exceeds its 1 s timeout, **When** a valid token is clicked, **Then** `302` still; the dedupe marker is removed so the impression can still be counted; `ads_clicks_total{outcome="record_failed"}` increments; **When** the stream recovers and the same token is clicked, **Then** it is counted once. (Safe because downstream deduplicates by click ID, AS-49.)
11. **AS-35** (dedupe or filter store down) — **Given** the store used for dedupe markers and spam counters is down or slower than its 100 ms timeout, **When** a valid token is clicked, **Then** `302`, never a `5xx`; the click is published `valid: 0, invalid_reason: "filter_unavailable"` (what cannot be vetted is not billed) and `ads_clicks_total{outcome="filter_unavailable"}` increments.
12. **AS-36** (the click endpoint never refuses) — **Given** 300 clicks with distinct valid tokens in one second from one address, **When** they arrive, **Then** every one answers `302` (no `429`, no `5xx`); the spam filter, not the rate limiter, decides what is billable (AS-38).
13. **AS-37** (hot-key salt, pure) — **Given** the salting function over a click ID, **Then** it is deterministic (a retried click goes to the same salt), always within `0–9`, and over 10,000 fixed distinct IDs each salt receives between 8% and 12%.

### User Story 4 — Click spam is filtered before billing (Priority: P1)

Bursts of clicks from one address and repeated clicks by one visitor on one campaign are recorded but never billed.

**Why this priority**: advertisers pay per click; unfiltered bursts are fraud and the first complaint.

**Independent Test**: click with many distinct valid tokens from one address and assert exactly how many are valid.

**Acceptance Scenarios**:

1. **AS-38** (address burst, exact under concurrency) — **Given** 25 valid tokens (different impressions, different campaigns), **When** all 25 are clicked at once from one address within one UTC minute, **Then** all 25 answer `302`; exactly 20 records are `valid: 1` and exactly 5 are `valid: 0, invalid_reason: "ip_burst"`; **Given** sequential clicks, **Then** the 20th is valid and the 21st is invalid; **When** the next UTC minute starts, **Then** the next click is valid again.
2. **AS-39** (repeat clicker) — **Given** one address (or one viewer hash, from other addresses) and one campaign, **When** 4 distinct impressions of that campaign are clicked within one UTC hour, **Then** the first 3 are valid and the 4th is `valid: 0, invalid_reason: "repeat_clicker"`; a different campaign from the same address is unaffected; the next UTC hour starts again at zero.
3. **AS-40** (duplicates do not poison the counters) — **Given** one counted click, **When** the same token is replayed 100 times from the same address, **Then** no record is published, and a fresh valid token from that address is still `valid: 1` (a replay consumes neither the address-burst nor the repeat-clicker budget).
4. **AS-41** (spam decision, pure) — **Given** the decision function over `(addressCountThisMinute, repeatCountThisHour, thresholds)`, **Then**, table-driven: counts at `19`, `20`, `21` for the address rule and `2`, `3`, `4` for the repeat rule give valid, valid, `ip_burst` and valid, valid, `repeat_clicker`; when both rules trip the reason is `ip_burst`; thresholds below 1 or non-integer are rejected; the function is monotone (more clicks never turn an invalid verdict valid).

### User Story 5 — Counting is exact and survives crashes, replays and bad messages (Priority: P1)

Valid clicks are aggregated per campaign per minute by a streaming job whose output and input progress commit together, so a crash never double-counts or loses a batch, a zombie instance cannot commit, a viral campaign does not overload one partition, and a poison message never blocks the stream. A raw log, deduplicated by click ID, is the evidence for reconciliation.

**Why this priority**: billing correctness rests on it (P0603).

**Independent Test**: publish click records to the real stream, run the aggregator (with crash and fencing injected), read the committed aggregates and the raw log.

**Acceptance Scenarios**:

1. **AS-42** (batch aggregation, pure) — **Given** the aggregation function over `(partition, firstOffset, records)`, **Then**, table-driven and as a property: records group by `(campaign, minute of received_at)`; `clicks` counts valid records and `invalid` counts invalid ones; a click ID that appears twice in the batch counts once (the first record's verdict); every output row carries `(partition, firstOffset)`; the output is independent of record order; `Σ clicks + Σ invalid` equals the number of distinct click IDs.
2. **AS-43** (speed path, end to end) — **Given** 1,000 click records of one campaign across the 10 salted keys (hence several partitions), including 50 duplicate click IDs and 30 invalid, **When** the aggregator has consumed them, **Then** the committed per-minute aggregates sum to the number of distinct valid clicks and distinct invalid clicks; a reader that sees only committed data sees nothing for a batch before its commit.
3. **AS-44** (crash before commit → still exactly once) — **Given** the aggregator is killed after it has sent a batch's aggregates but before it commits, **Then** that transaction is aborted and no reader sees the aggregates; **When** it restarts, **Then** it re-reads the batch from the last committed offset and the final aggregates equal those of a crash-free run (no loss, no double count); consumed offsets advance only together with the commit.
4. **AS-45** (zombie fencing) — **Given** two aggregator instances that share a transactional identity, **When** the older instance (thought dead) tries to commit after the newer one has started, **Then** its commit is rejected (fenced), its batch is not visible, `ads_aggregator_fenced_total` increments, and only the newer instance's output exists.
5. **AS-46** (replay-safe sink and hot-key merge) — **Given** an aggregate row `(C, minute m, partition 3, firstOffset 100, clicks 30)` delivered twice to the aggregate store, **Then** one effective row exists and the billing total is `30`, not `60`; **Given** rows for the same `(C, m)` from partitions `0–9` with different offsets, **Then** the per-minute total is their sum (salted partials merged).
6. **AS-47** (poison and duplicate delivery) — **Given** messages that are invalid JSON, miss a required field, have `valid` outside `{0,1}`, a non-UUID campaign ID, a `received_at` more than 5 minutes in the future or more than 7 days in the past, **When** they arrive mixed with valid ones, **Then** each bad message is dead-lettered with its reason and has no effect on any aggregate, the valid ones aggregate normally, offsets still advance (the stream is never blocked); **Given** the same valid message is delivered twice (the consumer is rewound), **Then** the aggregates show a single effect.
7. **AS-48** (late clicks) — **Given** a click whose `received_at` is more than 2 minutes older than the aggregator's processing time, **When** it is aggregated, **Then** it is counted into **its own** minute (not the current one), `ads_late_clicks_total` increments, and the hourly charge already posted for that hour is not touched (reconciliation corrects it, AS-62).
8. **AS-49** (raw log deduplicated by click ID) — **Given** the same `click_id` is written to the raw log twice, once with `valid: 1` and once with `valid: 0`, **When** the raw log is read for reconciliation, **Then** exactly one row per click ID is seen and it is the **first-recorded** verdict (deterministic).

### User Story 6 — Shops are charged exactly once per hour, never beyond their budget (Priority: P1)

Every hour the platform charges each campaign for the valid clicks of the previous hour (price × clicks), capped by the day's budget, and posts one ledger movement. Retries, overlapping runs and crashes never charge twice.

**Why this priority**: the money path.

**Independent Test**: load aggregates for an hour, run the hourly job (twice, concurrently, with a failure in between) and read the ledger balances through the ledger's exported service.

**Acceptance Scenarios**:

1. **AS-50** (hourly charge) — **Given** campaign `C` (CPC 25, budget 10,000) with aggregates of 40 valid clicks in hour `H` (spread over several partitions) and shop A's ledger balance `0`, **When** `ads.bill-hour` runs after `H` + 1 h + 5 min, **Then** a billing run `(C, H)` exists in state `CHARGED` with `clicks: 40, amountMinor: 1000`, an `AD_CHARGE` journal with reference `ad:<C>:<H>` exists, shop A's account is `−1000` and `PLATFORM_FEES` `+1000` (read with `getBalances`).
2. **AS-51** (retry and overlap) — **Given** AS-50, **When** the job runs again, or two runs for `H` race (`Promise.all`), **Then** no second charge: one run row, one journal, balances unchanged.
3. **AS-52** (crash between the run row and the journal) — **Given** the ledger refuses the first posting (`LedgerBusy`), **When** the job runs, **Then** it fails with the run left `PENDING` and no journal; **When** it runs again, **Then** the journal is posted once and the run becomes `CHARGED`; **Given** the journal was posted but the process died before the run was marked `CHARGED`, **When** the job runs again, **Then** the ledger answers `created: false`, the run becomes `CHARGED` and no second journal exists.
4. **AS-53** (daily budget cap across hours and days) — **Given** CPC 25 and budget 1,000: hour 1 has 30 clicks, hour 2 has 20, hour 3 has 5 (same UTC day), **When** billed in order, **Then** hour 1 charges `750`; hour 2 has `billableClicks: 10` of `20`, `amountMinor: 250`, `cappedClicks: 10`; hour 3 charges `0` (a `CHARGED` run with amount `0`, no journal); the day's total is `1000`; **Given** hour 23 of day D and hour 0 of day D+1, **Then** the budget restarts at 00:00 UTC.
5. **AS-54** (whole clicks only) — **Given** budget remaining `24` and CPC `25`, **When** the hour has 3 valid clicks, **Then** `billableClicks: 0` and `amountMinor: 0`; remaining `25` bills exactly 1 click; remaining equal to `clicks × CPC` bills them all with `cappedClicks: 0`.
6. **AS-55** (negative balances, ended campaigns, orphans) — **Given** shop A has balance `0`, **When** it is charged, **Then** the charge succeeds and the balance is negative (ad charges may overdraw); **Given** a campaign that was ended after serving, **Then** its clicks from the last hour are still billed; **Given** aggregates for a campaign ID that has no campaign row, **Then** no charge, `ads_billing_orphan_aggregate_total` increments.
7. **AS-56** (which hour) — **Given** no payload, **When** the job runs at `H` + 1 h + 7 min, **Then** it bills the hour `H` (the last closed hour, never the current one); **Given** an explicit hour that has not yet closed, **Then** the run is refused (`hour_not_closed`) and nothing is written; **Given** a campaign with no aggregates for the hour, **Then** no run row is created.
8. **AS-57** (billing arithmetic, pure) — **Given** `billable(clicks, cpcMinor, dailyBudgetMinor, billedEarlierTodayMinor)`, **Then**, table-driven and as a property (`fast-check`): `billableClicks = min(clicks, floor((budget − billedEarlier) / cpc))` and is never negative; `amount = billableClicks × cpc`; `amount ≤ budget − billedEarlier`; the result is an integer for integer inputs; more clicks never lower the amount.

### User Story 7 — A daily reconciliation corrects the books, and closed days are never rewritten (Priority: P1)

Every day the platform recomputes each campaign-hour from the raw, deduplicated, valid clicks and posts the difference as an adjustment. Once a day is reconciled it is closed: later corrections are adjustments in the **current** period that reference the original hour.

**Why this priority**: the notes make the batch path the source of truth for billing (P0614).

**Independent Test**: bill a day from aggregates, load raw clicks that disagree, run the reconciliation (twice, concurrently, with the source down) and read the run rows and ledger.

**Acceptance Scenarios**:

1. **AS-58** (over-billed → refund, idempotent) — **Given** yesterday's hour `H` was charged for 12 clicks (`300`) and the raw log holds 10 distinct valid clicks, 1 duplicate of one of them, and 1 invalid, **When** `ads.reconcile-day` runs, **Then** one `ADJUSTMENT` journal with reference `ad-adj:<C>:<H>:1` moves `50` back (shop A `+50`, `PLATFORM_FEES −50`), the run's net amount is `250`, shop A's net balance from this hour is `−250`; **When** it runs again, **Then** no new journal and no change.
2. **AS-59** (under-billed → extra charge) — **Given** the stream path counted 7 and the raw log has 10 valid distinct clicks (CPC 25), **When** reconciled, **Then** an adjustment of `+75` is charged to shop A and the net is `250`.
3. **AS-60** (an hour the stream path missed) — **Given** raw clicks for `(C, H)` and no billing run, **When** reconciled, **Then** a run `(C, H)` is created with source `reconciliation` and an `AD_CHARGE` journal with the **same** reference `ad:<C>:<H>` the hourly job would use; a later hourly run for `H` posts nothing.
4. **AS-61** (cap applied to the exact recomputation) — **Given** CPC 25, budget 1,000 and exact clicks `[30, 20, 5]` over three hours, while the stream path billed `[30, 10, 0]` clicks (`750`, `250`, `0`), **When** reconciled in hour order, **Then** the exact billable amounts are `750`, `250`, `0` and no adjustment is posted; **Given** the stream path had billed `[30, 20, 5]` without a cap by mistake (`750`, `500`, `125`), **Then** adjustments of `−250` and `−125` are posted.
5. **AS-62** (period close: closed days are never mutated) — **Given** day `D` was reconciled and is `COMPLETED`, **When** 3 more valid raw clicks for an hour of `D` become visible later, **Then** the next reconciliation (the window covers the last 3 closed days) posts an `ADJUSTMENT` journal dated **now** (the current period) whose reference names the original hour; the run row, charge journal and earlier adjustment of `D` are unchanged; **Given** a day older than the window, **Then** it is not re-examined by the schedule, but an explicit `ads.reconcile-day {day}` still processes it the same way.
6. **AS-63** (concurrent reconciliation) — **Given** two reconciliations of the same day started at once (`Promise.all`), **Then** one performs the work and the other is skipped (or waits and finds nothing to do); each adjustment is posted once.
7. **AS-64** (source unavailable) — **Given** the raw log cannot be read (down or timeout), **When** the reconciliation runs, **Then** it records a run in state `FAILED` with reason `source_unavailable`, posts no adjustment and no charge, `ads_reconciliation_runs_total{status="failed"}` increments, and the next scheduled run processes the day.
8. **AS-65** (drift visibility) — **Given** a day where the absolute difference between exact and billed clicks is more than 1% of exact clicks, **When** reconciled, **Then** `ads_reconciliation_drift_ratio{day}` holds the ratio and a warning is logged with the day and the totals; at 1% or below, no warning.
9. **AS-66** (what counts as a click for the recomputation) — **Given** raw rows at `23:59:59.999` of day D and `00:00:00.000` of D+1, one `valid: 0` row, and duplicate click IDs, **When** day D is reconciled, **Then** only valid distinct clicks received within `[D 00:00, D+1 00:00)` UTC count, the first falls in D and the second in D+1.
10. **AS-67** (adjustment arithmetic, pure) — **Given** `adjust(exactBillableMinor, netBilledMinor)`, **Then**, table-driven and as a property: the delta is `exact − net`; applying it makes net equal exact; applying it twice changes nothing (a zero delta posts no journal); adjustments are applied in a stable sequence per `(campaign, hour)`; and for any sequence of raw-click growth the final net equals `billable(finalExactClicks)`.

### User Story 8 — The advertiser sees what they are charged (Priority: P2)

A shop's owner or admin reads, per campaign, every hourly charge with its adjustments.

**Why this priority**: trust in the billing; support load.

**Independent Test**: bill and reconcile, then read the statement and compare with the ledger.

**Acceptance Scenarios**:

1. **AS-68** (statement) — **Given** a campaign with hours billed and one adjusted, **When** `OA` calls `GET /shops/A/ads/campaigns/:id/billing?from=…&to=…&limit=2`, **Then** `200 adBillingPageSchema`: items `{hour, state: "PENDING" | "CHARGED", source: "stream" | "reconciliation", clicks, billableClicks, cappedClicks, amountMinor, adjustments: {sequence, deltaClicks, deltaMinor, postedAt}[], netAmountMinor}` ordered by `hour` descending then campaign, keyset by an opaque cursor; `VA`/`SA` get `403`; another shop's campaign `404`; `from` after `to`, or a range over 92 days, answers `400`; a tampered cursor `400 invalid_cursor`.
2. **AS-69** (statement agrees with the ledger) — **Given** a billed and reconciled campaign, **When** the statement is read and shop A's `AD_CHARGE` and `ADJUSTMENT` journals with this campaign's references are summed, **Then** `Σ netAmountMinor` equals the absolute net movement of shop A's account for those references.

### User Story 9 — Serving stays honest when products and shops change (Priority: P2)

Campaigns follow the life of their product and shop: an archived product pauses its campaign, a deleted one ends it, a suspended shop stops serving, and out-of-order or duplicate events do no harm. This capability keeps its own copy of what it needs (R3) and never reads the catalog's or tenancy's tables.

**Why this priority**: serving an unavailable product or a suspended shop's ad is a trust and compliance failure.

**Independent Test**: deliver product and shop events (in order, reordered, twice, invalid) through the real consumers and assert serving, campaign state and outbox.

**Acceptance Scenarios**:

1. **AS-70** (product events: guard, order, duplicates, invalid) — **Given** `catalog.product_updated` with `productVersion: 3`, **When** a late `productVersion: 2` arrives, **Then** it is ignored and the read model keeps version 3; **When** version 3 is delivered twice, **Then** a single effect; **When** a payload fails validation (missing `productId`, non-UUID, negative `productVersion`), **Then** it is dead-lettered with no effect and the consumer continues.
2. **AS-71** (product lifecycle effects) — **Given** an `ACTIVE` campaign, **When** `catalog.product_archived` arrives, **Then** the campaign becomes `PAUSED` with `statusReason: "product_unavailable"`, `marketing.campaign_paused` and `product_sponsorship_changed {sponsored: false}` are published, and it is no longer served; **When** `catalog.product_restored` arrives, **Then** the campaign stays `PAUSED` (never resumes spending by itself); **When** `catalog.product_deleted` arrives, **Then** the campaign becomes `ENDED`; **When** `catalog.product_updated {inStock: false}` arrives, **Then** the campaign stays `ACTIVE` but is not served, and is served again after `{inStock: true}`.
3. **AS-72** (resume guards) — **Given** a `PAUSED` campaign with `statusReason: "product_unavailable"` whose product is still archived, **When** `POST …/resume`, **Then** `409 product_unavailable`; **Given** a paused campaign of a shop whose read model is not `ACTIVE`, **Then** `409 shop_inactive`; neither changes anything.
4. **AS-73** (shop events) — **Given** `tenancy.shop_status_changed {to: "SUSPENDED", shopVersion: 5}`, **Then** the shop's campaigns are not served; **When** `{to: "ACTIVE", shopVersion: 6}` arrives they are served again; **When** a late `shopVersion: 5` arrives after 6 it is ignored; `tenancy.shop_offboarding_started` stops serving; `tenancy.shop_deleted` ends all the shop's campaigns (billing runs and adjustments are kept as financial records); duplicates have a single effect and invalid payloads are dead-lettered.
5. **AS-74** (read model seeded at creation) — **Given** a campaign is created for `PA1` before any catalog event for it has been consumed, **Then** the product read model is filled from the catalog's batch lookup (title, category, stock, status, version) so the campaign can be served immediately; **When** an event with a lower `productVersion` arrives afterwards, **Then** it is ignored.
6. **AS-75** (event contract and atomicity) — **Given** each campaign event and the sponsorship event, **Then** it parses with its `packages/contracts` schema and carries the envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; **Given** a create whose transaction rolls back (forced failure after the campaign insert), **Then** no campaign, history row, sponsorship row or outbox event exists.

### User Story 10 — Observable, safe to operate, inside its boundaries (Priority: P2)

Operators can tell whether clicks are being counted and billed correctly; secrets are separated and rotatable; the domain keeps to its own tables.

**Independent Test**: scrape metrics after the scenarios above; start the app with bad configuration; run the static gates.

**Acceptance Scenarios**:

1. **AS-76** (metrics) — **Given** traffic from the scenarios above, **Then** `/metrics` exposes exactly: `ads_impressions_total{result}` (`served`, `degraded`), `ads_clicks_total{outcome}` (`counted`, `duplicate`, `invalid_token`, `expired`, `ip_burst`, `repeat_clicker`, `filter_unavailable`, `record_failed`), `ads_late_clicks_total`, `ads_aggregator_batches_total{result}`, `ads_aggregator_fenced_total`, `ads_billing_charged_minor_total`, `ads_billing_adjustment_minor_total{direction}`, `ads_billing_orphan_aggregate_total`, `ads_billing_lag_seconds` (end of the last billed hour to now), `ads_reconciliation_runs_total{status}`, `ads_reconciliation_drift_ratio{day}`; labels never hold campaign, shop, token or address values.
2. **AS-77** (configuration and secrets) — **Given** startup with the click-signing secret missing, shorter than 32 bytes, or equal to the session-signing or share-link secret, or a spam threshold that is `0`, negative or not an integer, **Then** startup fails naming the key; with a previous secret configured it must differ from the current one.
3. **AS-78** (errors) — **Given** every error case above, **Then** the body is problem+json with the stable `code` named in the scenario and a `requestId`; for any `5xx`, `detail` is generic and no stack, SQL, store or broker message reaches the client.
4. **AS-79** (log hygiene) — **Given** a captured log of a full serve → click → bill run, **Then** no line contains a click token, a signing secret, a raw address, a user ID next to an address, or a request body.
5. **AS-80** (boundaries and ownership) — **Given** the static gates, **Then** the `marketing` ads code issues no SQL, model injection or association on a table owned by another domain (`pnpm check:table-ownership` shows zero lines for it), no table of this capability has a foreign key to another owner's table, every table it owns is in the ownership registry, `pnpm check:boundaries` and `pnpm check:module-graph` are green, and the barrel exports only the Nest modules, DTO types and event contracts (no service, model, repository or consumer).
6. **AS-81** (migrations) — **Given** the migrations of this capability, **Then** they run up, down and up again; each sets a `lock_timeout`; none renames or drops a column that running code still reads (expand then contract); the old cross-owner foreign keys are dropped by their own step.
7. **AS-82** (graceful shutdown) — **Given** an aggregator mid-batch, **When** it receives the shutdown signal, **Then** it stops fetching, aborts or commits the open transaction (never leaves it open), disconnects, and the batch is processed exactly once after restart.
8. **AS-83** (capacity proof, operations artifact) — **Given** the load script `loadtest:ads-clicks` replaying 10 million synthetic clicks (10% duplicates, 5% invalid) at 50,000 clicks/s over 64 partitions, **Then** the raw-log distinct-valid count equals the generator's ground truth, the aggregates sum to the same number, the redirect latency stays within SC-002 and no partition receives more than 15% of one campaign's traffic.

### Edge Cases

- A token is valid but the product was deleted after serving: the click redirects to the product page (the storefront shows its own not-found); the click is still recorded and billed (AS-33).
- The daily budget is exhausted mid-hour: serving stops once the (approximate) spend counter says so; tokens already issued can still be clicked for up to 30 minutes, so the day's raw clicks may exceed the budget; the **charge** never does (AS-53, AS-61).
- Clock edge: a token whose expiry equals the current instant is expired (AS-24). The event time of a click is the server's receive time, never a client-supplied time.
- The same click ID can reach the raw log twice with different verdicts (store outage, retry): first-recorded wins (AS-49).
- A shop deleted while clicks are in flight: clicks are still aggregated; billing finds the campaign row (ended) and charges; if the campaign row is gone, the aggregate is an orphan (AS-55).
- Two hours missed entirely by the stream path: reconciliation creates both runs (AS-60).
- Daylight-saving and time zones never matter: hours and days are UTC.
- Viewer identifiers supplied by the client (`X-Anonymous-Id`) are untrusted: they only feed the keyed viewer hash; the address rule is the primary defence (AS-38, AS-39).

## Requirements *(mandatory)*

### Functional Requirements

**Campaigns**

- **FR-001**: A member with `shop.manage` MUST be able to create a campaign for one of the shop's `ACTIVE`, non-sandbox products with an integer CPC of 1–10,000 and an integer daily budget of 100–10,000,000 minor units, budget ≥ CPC, in `EUR` (AS-01, AS-02, AS-05).
- **FR-002**: The category MUST be copied from the product at creation; the request MUST NOT carry it, nor a currency or status (AS-01, AS-02).
- **FR-003**: Every campaign lookup and list MUST put the shop in the predicate; another shop's campaign, product or shop answers `404` with the same body as an unknown one (AS-04, AS-12).
- **FR-004**: At most one non-ended campaign MUST exist per product, and at most 50 non-ended campaigns per shop; both invariants are enforced by the store so racing requests yield exactly one winner (AS-06, AS-07).
- **FR-005**: The lifecycle is `ACTIVE ⇄ PAUSED → ENDED` (and `ACTIVE → ENDED`); `ENDED` is terminal; each change is a conditional update asserting one affected row, with a history row, in one transaction with its events; an illegal transition answers `409 invalid_transition` (AS-08, AS-09, AS-10, AS-15).
- **FR-006**: Campaign list MUST use keyset pagination ordered by `createdAt` descending then `id` descending, with an opaque cursor and `limit` 1–100 (default 20) (AS-12).
- **FR-007**: The system MUST publish `marketing.campaign_created|paused|resumed|ended` and, only when the sponsored value of a product changes, `marketing.product_sponsorship_changed` with a per-product monotonic `sponsorshipVersion`, through the outbox in the same transaction as the change (AS-01, AS-08, AS-11, AS-75).
- **FR-008**: Campaign mutations MUST be limited by `marketing.ads-write.shop` (fail closed), reads by `marketing.ads-read.shop` (fail open) (AS-14).

**Serving and tokens**

- **FR-010**: `GET /ads/sponsored` MUST return at most `limit` (1–3, default 3) items ordered by CPC descending then campaign ID ascending, at most one per shop, each marked `sponsored: true` (AS-16, AS-19, AS-23).
- **FR-011**: A campaign MUST be served only when it is `ACTIVE`, its product (per the product read model) is `ACTIVE`, in stock and non-sandbox, its shop (per the shop read model) is `ACTIVE`, and today's spend plus one click does not exceed the daily budget; `category=all` or absent matches every category (AS-17, AS-18).
- **FR-012**: The response MUST be `Cache-Control: private, no-store`, and MUST NOT disclose CPC, budget or any viewer identifier (AS-16, AS-20).
- **FR-013**: Each item MUST carry a click token that is signed with a dedicated secret (full-length keyed hash, never shared with sessions or share links), expires 30 minutes after being served, names the impression, campaign, shop and product, carries a one-way keyed viewer hash and the signing key ID, and holds no raw personal data (AS-16, AS-20, AS-24).
- **FR-014**: Verification MUST be constant-time, validate the claim shape, never throw, support one previous secret during rotation, and treat `now ≥ expiry` as expired (AS-24, AS-25).
- **FR-015**: If today's spend counters cannot be read within their timeout, serving MUST return an empty list rather than unchecked ads; if the database is unavailable it answers `503` (AS-21).
- **FR-016**: Serving MUST be limited by `marketing.ads-serve.ip` (fail open) (AS-22).

**Click endpoint**

- **FR-020**: `GET /ads/click/:token` MUST always answer a `302`: to `front/p/<productId>?ad=1` for a valid token, to `front/` for any invalid, forged, expired, oversized token; it is never limited by the rate limiter and never returns an error status caused by a downstream store (AS-26, AS-29, AS-34 – AS-36).
- **FR-021**: The redirect target MUST be built only from the configured storefront origin and the signed product ID (AS-30). The response is `Cache-Control: no-store`.
- **FR-022**: Each impression MUST be counted at most once: a dedupe marker is set atomically before anything is published and lives at least token lifetime plus 5 minutes; concurrent clicks yield exactly one counted click (AS-27, AS-28, AS-40).
- **FR-023**: `HEAD` requests and prefetch requests MUST NOT record a click and MUST NOT consume the impression (AS-31).
- **FR-024**: The client address MUST come only from the platform's trusted-proxy resolution, never from a client-supplied header on its own; it is stored only as a keyed one-way hash (AS-26, AS-32, AS-79).
- **FR-025**: A click on an impression served while the campaign was eligible MUST be recorded as billable even if the campaign has since been paused or ended (AS-33).
- **FR-026**: If recording the click fails or times out (1 s), the marker MUST be removed, the redirect still happens, and a later click on the same token counts once; if the dedupe/filter store is unavailable (100 ms timeout) the click is recorded invalid with `filter_unavailable` (AS-34, AS-35).

**Spam filter**

- **FR-027**: Before recording, the system MUST apply two rules: more than 20 clicks per minute from one address (any campaign) → `ip_burst`; more than 3 clicks per hour on one campaign from one address or from one viewer hash → `repeat_clicker`; windows are UTC minutes and hours; thresholds are configuration; the counters advance only for non-duplicate clicks and are exact under concurrency (AS-38, AS-39, AS-40, AS-41).
- **FR-028**: Invalid clicks MUST be recorded with their reason and counted in the `invalid` aggregate, and MUST NEVER be billed (AS-38, AS-42).

**Click records and aggregation (P0603)**

- **FR-030**: The click record on `ads.clicks` MUST be `{click_id, campaign_id, shop_id, product_id, received_at, ip_hash, viewer_hash, valid, invalid_reason}`, validated by a `packages/contracts` schema, published with an idempotent producer, keyed `campaignId#salt` where the salt is a deterministic function of the click ID in 0–9 (AS-26, AS-37).
- **FR-031**: Click aggregation MUST be a transactional read-process-write: a batch's aggregates and the consumed offsets commit atomically; readers only see committed aggregates (AS-43, AS-44).
- **FR-032**: Each aggregator instance MUST hold a stable transactional identity so that a zombie instance is fenced and cannot commit (AS-45).
- **FR-033**: Aggregates MUST be keyed `(campaign, minute, source partition, first offset of the batch)` so that a redelivered batch replaces its row, and salted partials of one campaign-minute MUST be summed when read (AS-46).
- **FR-034**: A click ID MUST count once per batch and once in the raw log (first-recorded verdict wins) (AS-42, AS-49).
- **FR-035**: Every consumed message MUST be validated; invalid ones are dead-lettered with a reason, have no effect, and never block the stream; delivering a valid message twice has a single effect (AS-47).
- **FR-036**: Aggregation is by the click's server receive time in one-minute event-time windows; a click more than 2 minutes late is aggregated into its own minute and counted in `ads_late_clicks_total`; it is never lost and never added to a later minute (AS-48).
- **FR-037**: Aggregates and the raw log MUST use the click's `received_at`, never a time from the client (AS-42, AS-48).
- **FR-038**: The aggregator MUST shut down gracefully without leaving a transaction open (AS-82).
- **FR-039**: Raw clicks MUST be retained for at least 400 days as billing evidence.

**Hourly billing (P0614)**

- **FR-040**: The hourly job MUST bill the last closed UTC hour, from the sum of the committed aggregates of each campaign, no earlier than 5 minutes after the hour ends; it refuses an hour that has not closed (AS-50, AS-56).
- **FR-041**: One billing run MUST exist per `(campaign, hour)`, enforced by a uniqueness constraint; states `PENDING → CHARGED`; the ledger posting is identified by the stable reference `ad:<campaignId>:<hour>` so the run and the posting converge after a crash in either order (AS-51, AS-52).
- **FR-042**: The charge is `billableClicks × CPC` with `billableClicks = min(clicks, floor((dailyBudget − billedEarlierToday) / CPC))`; whole clicks only; the day is the UTC day; a charge never exceeds the budget remaining (AS-53, AS-54, AS-57).
- **FR-043**: The charge MUST be posted as an `AD_CHARGE` journal debiting the shop's account and crediting `PLATFORM_FEES`; the posting runs in a transaction that touches only the ledger; the run's state is updated in a separate transaction of this domain; no network call happens inside either (AS-50, AS-52).
- **FR-044**: Ad charges may overdraw the shop's balance (AS-55).
- **FR-045**: Clicks of ended campaigns are billed; aggregates of an unknown campaign are skipped and counted (AS-55).
- **FR-046**: The job MUST be scheduled once per hour, run once across replicas, and be idempotent (AS-51).

**Reconciliation and period close (P0614)**

- **FR-050**: The daily job MUST recompute, for each campaign-hour of each of the last 3 closed UTC days, the exact billable clicks from the raw log (distinct click IDs, `valid = 1`, `received_at` within the day), apply the budget cap in hour order, and compare with the net billed amount (AS-58, AS-61, AS-66).
- **FR-051**: A difference MUST be posted as one `ADJUSTMENT` journal per `(campaign, hour, sequence)`, reference `ad-adj:<campaignId>:<hour>:<sequence>`, positive delta charging the shop and negative refunding it; a zero delta posts nothing; re-running with unchanged data posts nothing (AS-58, AS-59, AS-67).
- **FR-052**: An hour with raw clicks and no billing run MUST be charged by the reconciliation with the same reference the hourly job would use (AS-60).
- **FR-053**: A reconciled day is closed: its billing runs, charge journals and earlier adjustments are never updated or deleted; a later correction is an adjustment dated at its posting time, whose reference names the original hour; a day outside the 3-day window is processed only when explicitly requested (AS-62).
- **FR-054**: Two reconciliations of the same day MUST not both do the work (AS-63).
- **FR-055**: If the raw log cannot be read, the run MUST be recorded `FAILED` (`source_unavailable`) and change no money (AS-64).
- **FR-056**: A day whose absolute drift exceeds 1% of exact clicks MUST be reported through the metric and a warning (AS-65).
- **FR-057**: For every day, the net charges of a campaign MUST never exceed its daily budget, and every journal MUST sum to zero (AS-57, AS-67).
- **FR-058**: The advertiser statement MUST list each campaign-hour with its state, source, clicks, billable and capped clicks, amount, adjustments and net amount, keyset-paginated, for `payouts.read` members of the owning shop only (AS-68, AS-69).
- **FR-059**: `billedTodayMinor` on the campaign MUST come from posted charges only (AS-13).

**Read models and signals (IX.7)**

- **FR-060**: The product read model (title, category, stock, status, sandbox flag, shop ID, product version) MUST be maintained from the catalog's product events (R3), guarded by `productVersion`, idempotent, validated, dead-lettering invalid payloads, and seeded at creation from the catalog's batch lookup (R1) (AS-70, AS-74).
- **FR-061**: Archive pauses the campaign (`statusReason: product_unavailable`), restore never resumes it, delete ends it, out of stock only stops serving; resume is refused while the product is unavailable or the shop inactive (AS-71, AS-72).
- **FR-062**: The shop read model (status, shop version) MUST be maintained from tenancy's shop events (R3) with the same guarantees; a suspended or offboarding shop is not served; a deleted shop's campaigns end and its billing records stay (AS-73).
- **FR-063**: The maximum staleness accepted for both read models is 60 seconds at the 99th percentile of consumer lag; it is stated in `plan.md`.
- **FR-064**: This capability MUST NOT read or write any table, model or index it does not own, and MUST hold no foreign key to another owner's table (AS-80).

**Operations**

- **FR-070**: The metrics of AS-76, structured logs without secrets, tokens or addresses, problem+json errors with generic 5xx details (AS-76, AS-78, AS-79).
- **FR-071**: Configuration is validated at startup (secrets distinct and ≥ 32 bytes, thresholds positive integers) (AS-77).
- **FR-072**: Every outbound call has an explicit timeout: dedupe/filter store 100 ms, click publish 1 s, ledger posting and database per the platform defaults; retries only at the job level (AS-34, AS-35, AS-52).

### Key Entities *(include if feature involves data)*

- **Campaign**: a shop's sponsorship of one product: shop, product, category (copied), CPC, daily budget, currency, status, status reason, version. At most one non-ended per product.
- **Campaign history**: one row per status change with actor, from, to, time.
- **Product sponsorship**: per product, the current sponsored value and its monotonic version (what S32 consumes).
- **Product read model** and **Shop read model**: copies of the fields serving needs, with the source version (IX.8).
- **Click token**: not stored; a signed, expiring claim of one served impression.
- **Click record**: the evidence of one click: impression ID, campaign, shop, product, receive time, hashed address, viewer hash, verdict and reason. Raw log: one row per click ID.
- **Minute aggregate**: valid and invalid counts per campaign per minute per source batch.
- **Billing run**: one per campaign-hour: state, source, clicks, billable and capped clicks, amount, ledger reference.
- **Billing adjustment**: one per campaign-hour-sequence: click and money delta, ledger reference, state.
- **Reconciliation run**: one per day and pass: state `RUNNING | COMPLETED | FAILED`, hours checked, hours adjusted, net delta, drift ratio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In any replayed dataset, the clicks billed equal the number of distinct valid clicks exactly (zero difference) after reconciliation, whatever the duplicates, crashes, retries and reorderings in between.
- **SC-002**: At least 95% of clicks reach the product page redirect within 200 ms, and 100% of clicks receive a redirect even when the counting infrastructure is down.
- **SC-003**: No campaign is ever charged more than its daily budget on any day (zero violations), and no impression is billed twice (zero duplicates).
- **SC-004**: No forged, tampered or expired link is ever billed (zero), and no more than 20 clicks per minute from one address are billed.
- **SC-005**: Each closed hour is charged within 15 minutes of its end, and each day is reconciled within 4 hours of its end.
- **SC-006**: A shop sees every charge and adjustment for its campaigns in its statement within 15 minutes of posting, and the statement equals its ledger movement exactly.
- **SC-007**: After reconciliation the unexplained difference between the raw valid distinct clicks × price and the net amount charged is zero for every campaign-day; a drift above 1% raises an alert the same day.
- **SC-008**: The system sustains 50,000 clicks per second across 64 partitions with no single partition above 15% of one campaign's traffic.
- **SC-009**: A paused, ended, archived, out-of-stock or suspended-shop sponsored listing stops being shown within 60 seconds in 99% of cases (immediately for a seller action).
- **SC-010**: No shop can read or change another shop's campaigns or statements (zero cross-tenant successes).

## Assumptions

Each default below is also a line of `questions.md`.

- Everything is in `EUR`; the platform has one currency for ads today and the ledger contract for ad journals is `EUR`.
- Price (CPC) and daily budget cannot be edited; a seller ends the campaign and creates a new one. This keeps every click's price unambiguous.
- Mutations need `shop.manage` (OWNER, ADMIN), because they spend the shop's money; reads need `products.read`; the statement needs `payouts.read`. S03's matrix is not extended with an ads permission.
- Serving ranks by CPC only, one slot per shop, no quality score, no second-price auction. Ranking changes are configuration-level and out of scope.
- Spam thresholds (20 per address per minute; 3 per address-or-viewer per campaign per hour) use fixed UTC windows; the boundary effect of fixed windows is accepted.
- A shop's campaigns keep being billed for impressions served before a pause; the budget cap protects the advertiser.
- When the dedupe or filter store is down, an unvettable click is recorded invalid: the platform prefers under-billing to billing what it cannot vet.
- A click's event time is the server's receive time. Aggregation lateness allowance is 2 minutes; anything later is a metric and is corrected by reconciliation.
- Reconciliation covers the last 3 closed days on each run; older days only on request. The raw-log retention is 400 days.
- The click redirect is a `GET` that records a click, a documented exception to constitution V.5 ("GET never changes state"): the notes' design is a redirect click service. It is made safe by the impression being idempotent, `no-store`, `HEAD` and prefetch not counting, and the spam filter. The exception goes in `plan.md` Complexity Tracking.
- Ad charges post as ledger movements of S14 kinds `AD_CHARGE` and `ADJUSTMENT`; the shop's account may go negative for them (S14 contract). No automatic pause for a negative balance.
- Hours and days are UTC. The storefront origin `front` is a validated configuration value.
- The web screens do not exist yet and belong to W02 and W04; this spec defines what they may rely on.
- Capacity for the notes' target (50,000 clicks/s) is proven by an operations load script, not an e2e spec.

## Cross-capability contracts

Specs already written were searched (`grep` over `specs/domains` for `S36`, `marketing`, `sponsor`, `AdCampaign`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from S36 and how they are honoured:

- **S32** (`questions.md`, spec FR-019/FR-024, AS-31): wants `marketing.product_sponsorship_changed v1 {productId, shopId, sponsored, sponsorshipVersion}`. Honoured exactly (FR-007); topic fixed here as `marketing.events`, key `productId` (S32 left it open). S32 labels and boosts only; it does not need clicks.
- **S14**: S36 must replace `LedgerService.post`/`balance` and `LedgerModule` with `postJournal` (kinds `AD_CHARGE`, `ADJUSTMENT`), `getBalances`, and a stable `reference` per campaign-hour (honoured: FR-041, FR-043, FR-051; the exact reference formats differ from the example `campaignId:hour`, see `questions.md` `[CONTRACT]`). S14's `postJournal(input, tx)` requires a transaction; S36 supplies one that touches only the ledger (IX.4).
- **S05** (`gaps.md`): S36's `ads.service.ts` joins `Product`; it must use `getProductsByIds` with `{shopId}` for ownership and category, and snapshot events for the rest (honoured: FR-060, AS-74).
- **S34**: leaves sponsored slots to S36 (honoured: `GET /ads/sponsored`; no re-ranking inside recommendations).
- **S35**: nothing shared (honoured: Scope).
- **S10**: lists S36 as a consumer for "conversion"; not provided (`[CONTRACT]` in `questions.md`).
- **S03**: lists no S36 need beyond the shop-scoped guard; S36 consumes shop events (below).
- **S25** `gaps.md` F2 concerns share links (S37), not S36.

**Provides** (names exact; later specs read this):

- **HTTP** (schemas in `packages/contracts`; errors problem+json with `code`):
  - `POST /shops/:shopId/ads/campaigns` body `createAdCampaignRequestSchema = {productId: uuid, cpcMinor: int 1–10000, dailyBudgetMinor: int 100–10000000}` (strict) → `201 adCampaignSchema = {id, shopId, productId, category, cpcMinor, dailyBudgetMinor, currency: 'EUR', status: 'ACTIVE' | 'PAUSED' | 'ENDED', statusReason: 'seller' | 'product_unavailable' | null, campaignVersion, createdAt, updatedAt}`; permission `shop.manage`; codes `validation_failed` 400, `budget_below_cpc` 422, `campaign_limit_reached` 422, `product_not_sponsorable` 422, `shop_not_found` 404, `product_not_found` 404, `campaign_already_exists` 409, `permission_denied` 403, `rate_limited` 429.
  - `GET /shops/:shopId/ads/campaigns?status&limit&cursor` → `adCampaignPageSchema = {items: adCampaignSchema[], nextCursor: string | null}`; `products.read`.
  - `GET /shops/:shopId/ads/campaigns/:campaignId` → `adCampaignDetailSchema = adCampaignSchema & {billedTodayMinor}`; `products.read`; `campaign_not_found` 404.
  - `POST /shops/:shopId/ads/campaigns/:campaignId/pause | resume | end` (no body) → `200 adCampaignSchema`; `shop.manage`; `invalid_transition` 409, `product_unavailable` 409, `shop_inactive` 409.
  - `GET /shops/:shopId/ads/campaigns/:campaignId/billing?from&to&limit&cursor` → `adBillingPageSchema = {items: {hour, state, source, clicks, billableClicks, cappedClicks, amountMinor, adjustments: {sequence, deltaClicks, deltaMinor, postedAt}[], netAmountMinor}[], nextCursor}`; `payouts.read`.
  - `GET /ads/sponsored?category&limit` (anonymous) → `sponsoredSlotsResponseSchema = {items: {campaignId, productId, shopId, title, priceMinor, currency, sponsored: true, clickUrl, expiresAt}[], generatedAt}`; `Cache-Control: private, no-store`. Guarantees: at most 3 items, one per shop, every `clickUrl` is single-use and expires in 30 minutes.
  - `GET /ads/click/:token` (anonymous) → always `302` (`front/p/<productId>?ad=1` or `front/`), `Cache-Control: no-store`; never a `4xx`/`5xx`/`429`.
- **Events** (outbox → topic `marketing.events`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`): `marketing.campaign_created|paused|resumed|ended` key `campaignId` payload `{campaignId, shopId, productId, category, cpcMinor, dailyBudgetMinor, status, statusReason, campaignVersion}`; `marketing.product_sponsorship_changed` key `productId` payload `{productId, shopId, sponsored, sponsorshipVersion}` (`sponsorshipVersion` strictly increases per product, one event per change of `sponsored`).
- **Click stream**: topic `ads.clicks` (key `campaignId#0..9`), value `adClickRecordSchema` (field list in FR-030, snake_case as consumed by the analytics store); topic `ads.click-aggregates` (transactional output). Owned by `marketing`; no other capability may consume them.
- **Modules** (entry point `@app/domains/marketing`; nothing else exported): `AdsModule` (core: HTTP), `AdsWorkerModule` (worker: aggregator, hourly billing, reconciliation), `AdsProjectorModule` (projector: product and shop read-model consumers). Removed from the barrel: nothing S36 owns other than modules; `ShareLinksModule` and `LinkClicksProjector` remain S37's.
- **Rate-limit policies** (S50 registry): `marketing.ads-write.shop` 60/min per shop fail closed; `marketing.ads-read.shop` 300/min per shop fail open; `marketing.ads-serve.ip` 120/min per address fail open. The click endpoint has no policy (FR-020).
- **Jobs** (registered with S49): `ads.bill-hour` (minute 5 of every hour), `ads.reconcile-day` (daily at 02:30 UTC; payload `{day?: 'YYYY-MM-DD'}`).
- **Configuration keys**: `ads_click_secret`, `ads_click_secret_previous?`, `ads_spam_ip_per_minute` (20), `ads_spam_repeat_per_hour` (3), `front_host`, trusted-proxy setting.
- **Obligations on consumers**: **W02/S48** render the label "Sponsored" next to every item, use `clickUrl` as given (no rewriting, no caching, no prefetching the link), forward the viewer's identity (`X-Anonymous-Id` or session) when calling through a BFF (R2), treat `items: []`, `429` and `503` as "no ads", and validate the body with `sponsoredSlotsResponseSchema`. **W04** manages campaigns through the endpoints above and shows `statusReason`.
- Metrics of AS-76.

**Requires** (owning capability, exact shape assumed):

- **S14** (`payments`, `LedgerModule` / `LedgerService`, R1): `postJournal(input: {kind: 'AD_CHARGE' | 'ADJUSTMENT'; reference: string; currency: 'EUR'; lines: {accountId: string; amountMinor: number}[]}, tx: Transaction): Promise<{journalId: string; created: boolean}>` (once per `(kind, reference)`; errors `JournalUnbalanced`, `JournalConflict`, `LedgerBusy` retryable, `JournalInvalid`, `TransactionRequired`; no insufficient-balance error for these kinds); `getBalances({accountIds, currency}, tx?)`; `shopAccount(shopId)` (`SHOP_<id>`); `LEDGER_ACCOUNTS.PLATFORM_FEES`. Sign: the shop line is negative for a charge.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids, {shopId?})` (R1) with `ProductDto {id, shopId, title, category, quantity, inStock, status, isSandbox, productVersion}`; events `catalog.product_created|updated|archived|restored|deleted` on topic `products.events` (key `productId`), payload `{productId, shopId, title, category, inStock, status, isSandbox, productVersion, …}` (`deleted`: `{productId, shopId, productVersion}`) (R3).
- **S03** (`tenancy`): the shop-scoped permission decorator `ShopScoped(permission)` with `shop.manage`, `products.read`, `payouts.read` and the `404`-for-non-members behaviour; events `tenancy.shop_status_changed {shopId, from, to, shopVersion}`, `tenancy.shop_offboarding_started {shopId, purgeAt}`, `tenancy.shop_deleted {shopId}` (R3).
- **S01** (`identity`): `Firewall({anonymous: true})` and the current user, optionally present on anonymous routes.
- **S49** (job scheduler): single-run, idempotent scheduled jobs with advisory-lock or claim semantics.
- **S50** (rate limiter): the three policies above with fail-open and fail-closed modes.
- **S53** (events and projections): outbox `append` joining the caller's transaction; the idempotent, versioned, zod-validated consumer framework with dead-lettering; the transactional producer and consumer client; the analytics-store client.
- **S54** (platform toolkit): problem+json filter, request context, metrics registry, config validation, trusted-proxy address resolution, clock, graceful shutdown.
- **W02/W04** (web): none required from them; they consume the HTTP above.
