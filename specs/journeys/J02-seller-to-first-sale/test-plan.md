# Test Plan: J02 — Seller to First Sale

Constitution VII.8: one row per acceptance scenario in [`spec.md`](spec.md) (33 rows). A rule already proven inside one capability is referenced in the last column, never re-tested here. Where the last column names a capability and a topic without a scenario number, that capability's `test-plan.md` has no stable scenario id for it yet; the implementation agent fills the number when it lands.

- Journey file: `packages/backend/test/journeys/seller-to-first-sale.journey-spec.ts`, top-level `describe` "Journey J02: seller to first sale", one nested `describe` per user story. It runs against the **running local stack** (`moon run infra-setup`, then `moon run dev-monolith`; `pnpm test:journeys`; `API_URL` default `http://localhost:8000`), black box: public APIs, the receiver `R` and the control surface only; no database, topic or queue reads.
- Waiting: `waitForContract(hop, probe)` over `test/utils/async-helpers.ts` `waitFor` (poll 250 ms, deadline = 2 × the hop's maximum in `spec.md`, × `JOURNEY_TIME_FACTOR`). No fixed sleeps.
- Fixtures (`test/journeys/support/`): J01's kit plus `sellerFixture`, `webhookReceiver`, `fixtures/kyc-*.pdf`. `controlSurface` restores the clock and resumes every paused group in `afterAll`.
- Provider doubles at the edge: payment by `paymentMethodRef`, model by fixture content, admin bootstrap, receiver allow-list.
- Order of the file: US1 → US2 (AS-06) → US3 (AS-12) → US4 (AS-18) → US5 (AS-25) share one seller; every other scenario creates its own shop and unique titles.
- UI: none (no capability owns a billing screen; W04's journeys cover its own screens).
- Static gates (AS-33): `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`.

| Scenario | Journey test (`packages/backend/test/journeys/seller-to-first-sale.journey-spec.ts`) | Already proven by capability (ID) |
|---|---|---|
| AS-01 register and open a shop | `US1`: register `202`, login, `POST /shops` with key; `GET /shops/mine` | S01 (register, login), S03 AS-01 (shop, membership, outbox rows) |
| AS-02 role follows the shop by event | `US1`: poll `GET /auth/me` until `SELLER`; refreshed token claim | S01 (promotion consumer, conditional and idempotent), S03 (event payload) |
| AS-03 retried create, same key | `US1`: ×5 concurrent same key; one shop, one membership; different body `422` | S54 (idempotency facility); S03 (slug uniqueness) |
| AS-04 a stranger sees nothing | `US1`: second user reads shop and onboarding, `404` | S03 (IDOR matrix), S04 SC-001 (shop-scoped `404`) |
| AS-05 identity consumer catches up | `US1`: pause `identity-seller-promotion`, create shop, resume, role once, lag `0` | S01 (consumer idempotency, DLQ), S53 (pause, lag) |
| AS-06 automatic approval | `US2`: questionnaire, submit, documents with `kyc-ok-*`, poll document `APPROVED`, shop `VERIFIED`, `payoutsEnabled` | S04 (questionnaire, document rules, extraction, approval rule), S03 AS-71, AS-72 (projection of onboarding events) |
| AS-07 human review path | `US2`: `kyc-unclear.pdf`, admin lists and resolves `APPROVE`, shop `VERIFIED`; non-admin `403` | S04 (review queue, resolve rules, conflict of interest) |
| AS-08 application rejected | `US2`: `kyc-forged.pdf`, `REJECT_APPLICATION`, shop `REJECTED`, `payoutsEnabled: false`; stale `verified` ignored | S04 (reject path), S03 AS-72 (version guard) |
| AS-09 duplicate and out-of-order onboarding events | `US2`: replay `shop-onboarding` for `tenancy-shop-lifecycle`; shop and `shopVersion` unchanged | S03 AS-71, AS-72 (tolerant to order), S53 (replay) |
| AS-10 extractor down, then back | `US2`: stop extractor, upload, documents `QUEUED`; start, verified; repeat `uploaded` | S04 (one model call per document, lease), S55 (queue, DLQ wiring) |
| AS-11 crash between approval and verification | `US2`: shop with all documents approved, run `onboarding.verify-pending` twice | S04 (verification rule, single `shop.verified`) |
| AS-12 subscribe, charge, entitlements | `US3`: subscribe with key, free tier until `PAID`, then `ACTIVE`, `maxProducts = m`, `Shop.plan` | S17 (subscribe, invoice, charge job, J02 promise), S18 (entitlement build), S03 AS-73 (plan projection) |
| AS-13 retried subscribe, same key | `US3`: ×5 concurrent same key; one invoice; other body `422`; no key `422` | S17 (idempotency replay, in-flight, different body), S54 |
| AS-14 first charge declined | `US3`: `pm_test_declined`, free tier throughout; fix method, advance clock, `billing.run`, `ACTIVE` | S17 (decline classification, dunning, payment-method update), S18 (stale-no repair) |
| AS-15 entitlements cache catches up | `US3`: pause `entitlements-invalidation`, subscribe, resume; entitlements `m` once | S18 (inbox by `eventId`, version guard, TTL fallback), S53 (pause, lag) |
| AS-16 duplicate and replayed billing events | `US3`: replay `billing.events` for two groups; nothing changes | S18 (stale version ignored), S03 AS-73 |
| AS-17 plan limit applies | `US4`: fill free tier, `409 plan_limit_reached`, subscribe, create again `201` | S18 (`checkLimit`), S05 (refusal writes nothing, fails closed) |
| AS-18 list, then find | `US4`: create with key, anonymous search by unique title with `shopId`, `GET /products/:id` | S05 AS-82 (one outbox row per change, snapshot payload), S32 (index from events, visibility), S43 (`product.created` routing) |
| AS-19 retried create, same key | `US4`: ×5 concurrent same key; one product, one hit, one event id at `R` | S54 (idempotency), S43 AS-30 (duplicate source event) |
| AS-20 index consumer down, then catch-up | `US4`: pause `search-product-index`, create, resume; hit once | S32 (idempotent projector, replay), S53 (lag) |
| AS-21 edits and archive reach search in order | `US4`: patch, archive, restore; search converges; replay `products.events` | S05 (versions, OCC, transitions), S32 (version guard), S05 AS-40 (cache invalidation) |
| AS-22 suspension hides, reinstatement shows | `US4`: admin suspend, product leaves search; reinstate | S03 (suspend, status event), S32 (shop-state copy), S10 (checkout refusal for inactive shop) |
| AS-23 events arriving before their shop | `US4`: pause, create shop and product, resume; one hit, never a flicker | S32 (shop-state ordering, hidden while unknown) |
| AS-24 webhook endpoint for the shop | `US5`: create endpoint to `R`, secret once, staff `403`, other shop `404` | S43 (create, secret shown once, permission, SSRF, scope) |
| AS-25 the sale end to end | `US5`: J01 purchase of `P`; search `inStock: false`; `R` gets one signed `order.paid` sliced to `S`; attempts API `ok`; rank and board | J01 AS-01 (paid), S10 (stock via `ProductStockService`), S43 AS-24 (version shape), S43 (signature, headers), S40 (ranking, periods) |
| AS-26 two-shop order | `US5`: order with products of two shops, each receiver gets its slice, rank grows by own subtotal | S43 AS-30 (one event per shop), S40 (per-shop revenue), S10 (shop split) |
| AS-27 receiver fails, then recovers | `US5`: `R` answers `500`, advance clock, `webhooks.retry`, `R` answers `200`; same id; replay with key | S43 AS-33 (queue), S43 (retry schedule, breaker, replay with key, `Marketplace-Replay`) |
| AS-28 router or leaderboard consumer down | `US5`: pause `webhook-router`, pay, resume; pause `leaderboards`, pay, resume | S43 AS-30, AS-31 (idempotent, DLQ), S40 (idempotent per `orderId`), S53 (pause, lag) |
| AS-29 duplicate and replayed order events | `US5`: replay `orders.events` and `products.events` for five groups; observables identical | S43 AS-30, S40 (Lua seen-set), S32, S05 AS-40, S53 (replay) |
| AS-30 renaming the shop reaches the board | `US5`: `PATCH /shops/S`; board `name` changes, rank same | S03 (`shop_updated` with `shopVersion`), S40 (read model copy, version guard) |
| AS-31 a cancelled order is not a sale | `US5`: declined and expired orders for `P3`; no webhook, rank unchanged, stock back | J01 AS-17, AS-19 (compensation), S10 (stock release), S40 (only `order.paid` counts) |
| AS-32 every hop is observable | `US6`: metrics counters moved; all journey groups `lag: 0`, `RUNNING`; log fields; no secrets | S54 (metrics, request context, redaction), S53 (lag endpoint), S04 AS-66 (onboarding metrics) |
| AS-33 approved paths only | `US6`: static gates (CI job, not an HTTP test) | S03, S04, S05 (table ownership, no foreign models), S54 |
