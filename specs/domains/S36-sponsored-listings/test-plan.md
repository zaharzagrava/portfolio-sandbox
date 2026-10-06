# Test Plan: S36 — Sponsored Listings (domain `marketing`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (83 scenarios, AS-01 to AS-83), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a cell names two parts, each proves a different part of the scenario (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/domains/marketing/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`AdsModule`, `AdsWorkerModule`, `AdsProjectorModule` as the file needs, plus the real identity, tenancy, catalog (R1 service and events), payments (`LedgerModule`), rate-limit and outbox modules they depend on) with the production global pipe, filter, prefix and interceptors, call them through `supertest`, and run against real Postgres (migrated), Redis, the Kafka stand-in and ClickHouse from `docker-compose.test.yaml`. Streaming scenarios publish real messages to the real topics (`ads.clicks`, `products.events`, the tenancy topic) and let the real consumers process them; where a test needs a precise partition, offset, or crash point it delivers a batch through the consumer's batch handler. No test calls a private method, and `AdsService.click`, `AdBillingJobs.billHour` or `reconcileDay` are exercised through HTTP or through the scheduler's job entry (the job handler), never by importing the service.
- Only system-edge dependencies are faked or spied: the access-token verifier, time (frozen; the clock is advanced explicitly for token expiry, hour and day boundaries, lateness), and, to force a fallback path (VII.9), a failure or delay injected on the Redis client (AS-21, AS-35), the Kafka producer (AS-34), the ClickHouse client (AS-64) and the ledger service's first call (AS-52). The ledger, outbox, aggregate store, raw log, dedupe markers and counters are real. Every test asserts the response **and** the persisted effect (rows, outbox rows, ledger balances through `getBalances`, published records, committed offsets, dead-letter rows, metrics) and resets state first (`clean()`, truncate of the analytics tables, flush of the ads keyspace, a fresh consumer group id).
- Every e2e parses success bodies with the matching `packages/contracts` schema (`adCampaignSchema`, `adCampaignPageSchema`, `adCampaignDetailSchema`, `adBillingPageSchema`, `sponsoredSlotsResponseSchema`) and error bodies with the problem schema (VII.6). Click records are parsed with `adClickRecordSchema`.
- VII.4 pair for each consumer: aggregator AS-47 (duplicate delivery and invalid payloads), product-event consumer and shop-event consumer AS-70 and AS-73 (duplicate delivery and invalid payloads in the same rows).
- Concurrency (`Promise.all`): AS-06, AS-07, AS-10, AS-28, AS-38, AS-51, AS-63.
- "Crash" (AS-44, AS-52, AS-82) is a consumer or job stopped without its shutdown hooks at a named point; "zombie" (AS-45) is a second aggregator started with the same transactional identity.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5). Money and counting invariants also get `fast-check` properties (AS-23, AS-24, AS-42, AS-57, AS-67). Randomised inputs use a fixed seed. No unit tests for controllers, repositories, consumers, job handlers or glue.
- UI journeys (Playwright, happy path only, owned by the web capabilities; no edge case from the API layer is repeated): W02 `packages/web/tests/sponsored-listing.spec.ts`, W04 `packages/web/tests/ad-campaign.spec.ts`. Their owners do not exist yet (`questions.md`, CONTRACT).
- Static gates (VII.1, AS-80): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:module-graph`; `pnpm check:model-registry`; `pnpm check:table-ownership --strict`.
- The capacity proof of AS-83 and SC-008 is an operations artifact (`loadtest:ads-clicks`), not an e2e row. Drift alert routing (SC-007) is an ops artifact (runbook `docs/runbooks/AdReconciliationDrift.md`); the metric itself is asserted in AS-65.
- Fallback paths (VII.9) each have a test that forces them: spend counters down (AS-21), dedupe/filter store down (AS-35), click publish down (AS-34), aggregator crash and zombie (AS-44, AS-45), ledger busy and crash after posting (AS-52), raw log down (AS-64).

Abbreviations for the e2e files (all under `libs/domains/marketing/`):

| Key | File | Top-level `describe` |
|---|---|---|
| C | `ads-campaigns.e2e-spec.ts` | `Sponsored listings: campaigns` |
| V | `ads-serving-clicks.e2e-spec.ts` | `Sponsored listings: serving and clicks` |
| A | `ads-aggregation.e2e-spec.ts` | `Sponsored listings: click aggregation` |
| B | `ads-billing.e2e-spec.ts` | `Sponsored listings: billing and reconciliation` |
| M | `ads-readmodels.e2e-spec.ts` | `Sponsored listings: product and shop read models` |
| P | `ads-platform.e2e-spec.ts` | `Sponsored listings: operations and boundaries` |

Unit files (all under `libs/domains/marketing/domain/`): U1 `campaign-state.spec.ts`, U2 `slot-ranking.spec.ts`, U3 `click-token.spec.ts`, U4 `hot-key-salt.spec.ts`, U5 `spam-filter.spec.ts`, U6 `click-aggregation.spec.ts`, U7 `billing-math.spec.ts`, U8 `adjustment-math.spec.ts`.

## Traceability

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create | C: `201`, schema, rows, history, `campaign_created` + sponsorship v1 in outbox | W04 `ad-campaign.spec.ts`: seller creates a campaign (data seeded through the API) | — |
| AS-02 validation classes | C: every class `400`, `422 budget_below_cpc`, nothing written | — | — |
| AS-03 authentication and roles | C: `401`, `403` for `VA`/`SA`, success for `AA`/`OA`, statement `403` | — | — |
| AS-04 cross-tenant | C: `404` for B's campaign via A, B path, B's product; no change | — | — |
| AS-05 product eligibility | C: archived, sandbox, unknown, out-of-stock | — | — |
| AS-06 one open campaign per product | C: `409`, re-create after end, two creates race | — | — |
| AS-07 per-shop limit | C: 51st `422`, race at 49 | — | — |
| AS-08 pause, resume, end | C: statuses, versions, events, history rows | W04 `ad-campaign.spec.ts`: seller pauses the campaign | — |
| AS-09 illegal transitions | C: each illegal pair `409`, no event | — | — |
| AS-10 concurrent transitions | C: two `pause`, two `end` race | — | — |
| AS-11 sponsorship only on change | C: end while paused publishes no sponsorship event | — | — |
| AS-12 list | C: keyset, filter, invalid limit/status/cursor | — | — |
| AS-13 read one | C: detail with `billedTodayMinor` from posted charges | — | — |
| AS-14 write rate limit | C: `429` with `Retry-After`; limiter down → `503`, nothing written | — | — |
| AS-15 state machine | — | — | U1: `it.each` over 3 × 3 pairs, sponsored value |
| AS-16 serving | V: `200`, headers, schema, order, tokens verify, no CPC/budget, metric | W02 `sponsored-listing.spec.ts`: shopper sees a labelled sponsored card | — |
| AS-17 category semantics | V: `all`, none, unknown category, invalid categories | — | — |
| AS-18 eligibility filters | V: one case per condition and its reversal | — | — |
| AS-19 diversity, limit, tie-break | V: one per shop, equal CPC order, `limit` bounds | — | — |
| AS-20 fresh token, no personal data | V: two calls differ; decoded claims hold no raw identifiers | — | — |
| AS-21 serving degradation | V: counters down → `200 []` + metric; database down → `503` generic | — | — |
| AS-22 serving rate limit | V: 121st `429`; limiter down → served | — | — |
| AS-23 ranking | — | — | U2: table + `fast-check` property |
| AS-24 token | — | — | U3: table (valid, expiry edge, tampering, shape, wrong secret, no throw) + property |
| AS-25 key rotation | V: previous-key token counted; removed → invalid; new tokens carry the current key ID | — | — |
| AS-26 click, happy path | V: `302`, `Location`, one published record (schema), salted key, marker TTL, no raw address | W02 `sponsored-listing.spec.ts`: shopper clicks the card and lands on the product page | — |
| AS-27 duplicate click | V: second click `302`, no record, metric | — | — |
| AS-28 concurrent duplicate | V: 20 simultaneous clicks, one record | — | — |
| AS-29 invalid tokens | V: each kind redirects home, nothing published, metric reason | — | — |
| AS-30 no open redirect | V: injected params and spoofed host ignored | — | — |
| AS-31 HEAD and prefetch | V: not recorded, not consumed, later `GET` counted | — | — |
| AS-32 trusted client address | V: forged headers collapse to one address; trusted proxy honoured | — | — |
| AS-33 click after pause | V: recorded valid after pause/end | — | — |
| AS-34 recording fails | V: publish down/timeout → `302`, marker removed, later click counted once | — | — |
| AS-35 dedupe/filter store down | V: `302`, record `filter_unavailable`, no `5xx` | — | — |
| AS-36 endpoint never refuses | V: 300 rapid clicks all `302` | — | — |
| AS-37 hot-key salt | — | — | U4: determinism, range, distribution over 10,000 fixed IDs |
| AS-38 address burst | V: 25 concurrent → 20 valid + 5 `ip_burst`; boundary; minute reset | — | — |
| AS-39 repeat clicker | V: 4th invalid per address and per viewer hash; other campaign unaffected; hour reset | — | — |
| AS-40 duplicates do not poison counters | V: 100 replays, fresh token still valid | — | — |
| AS-41 spam decision | — | — | U5: table over counts and thresholds, precedence, monotonic |
| AS-42 batch aggregation | — | — | U6: table + `fast-check` (order independence, conservation) |
| AS-43 speed path | A: 1,000 clicks, duplicates, invalid; committed sums; read-committed visibility | — | — |
| AS-44 crash before commit | A: kill after send, before commit; restart; equals crash-free run; offsets with commit | — | — |
| AS-45 zombie fencing | A: older instance's commit rejected, metric, only newer output | — | — |
| AS-46 replay-safe sink, hot-key merge | A: duplicate aggregate row one effect; partials of 10 partitions summed | — | — |
| AS-47 poison and duplicate delivery | A: each bad message dead-lettered, offsets advance, valid ones counted; same message twice, one effect | — | — |
| AS-48 late clicks | A: counted in own minute, metric, hourly charge untouched | — | — |
| AS-49 raw log dedupe | A: same `click_id` twice with different verdicts, first wins | — | — |
| AS-50 hourly charge | B: run `CHARGED`, journal reference, balances via `getBalances` | — | — |
| AS-51 retry and overlap | B: second run and two racing runs, one charge | — | — |
| AS-52 crash between run row and journal | B: `LedgerBusy` → `PENDING`; rerun posts once; journal-posted-then-crash → `created: false`, `CHARGED` | — | — |
| AS-53 budget cap across hours and days | B: `[30, 20, 5]` clicks, caps, UTC reset | — | — |
| AS-54 whole clicks only | B: remaining `24`/`25`/exact | — | — |
| AS-55 negative balance, ended, orphan | B: overdraw, ended campaign billed, orphan skipped + metric | — | — |
| AS-56 which hour | B: default last closed hour, open hour refused, no aggregates no row | — | — |
| AS-57 billing arithmetic | — | — | U7: table + `fast-check` (budget never exceeded, integers, monotone) |
| AS-58 over-billed refund | B: `ADJUSTMENT` `+50`/`−50`, net `250`, second run no-op | — | — |
| AS-59 under-billed extra charge | B: `+75` | — | — |
| AS-60 missed hour | B: run `reconciliation`, same reference, later hourly no-op | — | — |
| AS-61 cap on recomputation | B: no adjustment when correct; `−250`, `−125` when mis-billed | — | — |
| AS-62 period close | B: closed day untouched; late click → adjustment dated now; 3-day window; explicit older day | — | — |
| AS-63 concurrent reconciliation | B: two at once, one effect | — | — |
| AS-64 source unavailable | B: raw log down → `FAILED`, no money moved, next run processes | — | — |
| AS-65 drift visibility | B: ratio gauge and warning above 1%, none at or below | — | — |
| AS-66 what counts as a click | B: UTC day boundary, invalid excluded, duplicates collapsed | — | — |
| AS-67 adjustment arithmetic | — | — | U8: table + `fast-check` (final net equals exact, idempotent) |
| AS-68 statement | B: items, adjustments, keyset, roles, `404`, range and cursor errors | — | — |
| AS-69 statement equals ledger | B: `Σ netAmountMinor` equals the ledger movement for the references | — | — |
| AS-70 product events: guard, order, duplicates, invalid | M: late version ignored, duplicate one effect, invalid dead-lettered | — | — |
| AS-71 product lifecycle effects | M: archive pauses, restore stays paused, delete ends, out of stock stops serving | — | — |
| AS-72 resume guards | M: `409 product_unavailable`, `409 shop_inactive` | — | — |
| AS-73 shop events | M: suspend/reinstate, reorder, offboarding, deleted ends campaigns, duplicate, invalid | — | — |
| AS-74 read model seeded at creation | M: served immediately; lower-version event ignored | — | — |
| AS-75 event contract and atomicity | M: every event parses with its schema and envelope; forced rollback leaves no row or event | — | — |
| AS-76 metrics | P: scrape after a scripted run, exact names and labels, no high-cardinality labels | — | — |
| AS-77 configuration and secrets | P: boot with each bad value, startup fails naming the key | — | — |
| AS-78 errors | P: every error case parses as problem+json; injected `5xx` has a generic `detail` | — | — |
| AS-79 log hygiene | P: captured log of serve → click → bill holds none of the forbidden values | — | — |
| AS-80 boundaries and ownership | P: ownership registry lists every table; static gates run in CI (see above) | — | — |
| AS-81 migrations | P: up, down, up; `lock_timeout`; expand/contract; old foreign keys dropped | — | — |
| AS-82 graceful shutdown | P: shutdown mid-batch leaves no open transaction; batch processed once after restart | — | — |
| AS-83 capacity proof | ops artifact `loadtest:ads-clicks` (10M events, 50k/s): ground-truth equality, redirect latency, partition share | — | — |
