# Data Model: J02 — Seller to First Sale

J02 owns no business entity and adds **no table, topic, queue or migration of its own**. Every entity below is owned by another capability and is only observed through public APIs. What J02 adds is test-kit types and a handful of local-profile settings (rows marked *setting*), each refused at startup in production.

## Entities observed (owner → observable)

| Entity | Owner | Observable | States the journey asserts |
|---|---|---|---|
| User (role) | identity (S01) | `GET /auth/me`, refreshed token | `USER → SELLER` once, by `tenancy.shop_created` |
| Shop, membership | tenancy (S03) | `GET /shops/:id`, `GET /shops/mine` | `verificationStatus` `UNVERIFIED → PENDING → VERIFIED | REJECTED`; `payoutsEnabled`; `plan` `STARTER → <plan of Pr>`; `status` `ACTIVE ↔ SUSPENDED` |
| Application, document, review task | seller-onboarding (S04) | `GET /shops/:id/onboarding`, `GET /admin/onboarding/reviews` | document `QUEUED → APPROVED | NEEDS_REVIEW`; application `SUBMITTED → VERIFIED | REJECTED` |
| Subscription, invoice, entitlements | billing (S17), S18 | `GET /shops/:id/subscription`, `…/invoices` | interim (free-tier entitlements) → `ACTIVE`; invoice unpaid → `PAID`; declined first charge leaves free tier |
| Product, index document | catalog (S05), discovery (S32) | `GET /shops/:id/products`, `GET /products/search` | `productVersion` increases; index converges to the last version; hidden while the shop is not active |
| Webhook endpoint, event, attempt | developer-platform (S43) | `…/developers/webhooks/:id/attempts?eventId=` | one event id per (source event, shop); attempts `ok:false` then `ok:true` |
| Board entry, rank | seller-insights (S40) | `GET /leaderboards`, `GET /shops/:id/rank` | `404 not_ranked → 200`, revenue grows once per order |
| Consumer group | S53 | `GET /api/admin/consumers/:group` | `state`, `lag` |

## Test-kit types (test code only, `packages/backend/test/journeys/support/`)

- `Hop = 'H1'…'H17'` → `{ maxMs, owner }`; deadline = `2 × maxMs × JOURNEY_TIME_FACTOR`. J01's table covers its own H1–H13; J02's hop ids are namespaced (`J02.H1`…) so the two tables never collide.
- `SellerFixture` (extends J01's): `{ owner: Actor, staff: Actor, shopId, slug, plan, productIds, endpointId, endpointSecret }`; each builder is idempotent (409 → open the existing resource, L-010).
- `WebhookReceiver`: HTTPS server on an ephemeral port; `received: {id, deliveryId, attempt, type, replay, body}[]`; `answer(200 | 500 | hang)` per request count; verifies each request with S43's reference verifier.
- `KycFixture { name, path, sha256, size, contentType }` for `kyc-ok-registration.pdf`, `kyc-ok-bank.pdf`, `kyc-ok-vat.pdf`, `kyc-unclear.pdf`, `kyc-forged.pdf`.
- `Recorded { shop, onboarding, subscription, invoices, searchDoc, receiverIds, rank, boardEntry }` — snapshot used by AS-09, AS-16, AS-29 to compare "identical observables" after a replay.

## Local-profile settings (not data; each validated at startup, refused when `NODE_ENV=production`)

| Setting | Meaning | Owner |
|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | provisions one platform `ADMIN` | S01 |
| `PROVIDER_DOUBLES=enabled` | payment methods `pm_test_*`; model double by fixture content | S17/S13, S04/S46 |
| `allowedReceiverHosts` (host:port list) | lets the test's HTTPS receiver be registered and called | S43, S54 `safeRequest` |
| `CLOCK_CONTROL=enabled` | admin clock (J01) | S54 |
| search `refresh_interval` ≤ 1 s | makes H9–H11 reachable | S32 |
| rate-limit allow-list for the journey address | many accounts from one IP | S50 |

## State transitions asserted across domains

- Shop verification is monotone in `submissionNo`: an older `shop.verified` never lifts a newer `shop.rejected`; replays leave `shopVersion` unchanged (AS-08, AS-09).
- Entitlements never show the paid plan before the first invoice is `PAID` (AS-12, AS-14); older `subscriptionVersion` is ignored (AS-16).
- A search document applies only a higher `productVersion` (AS-21, AS-29); a product of a shop that is not known-active is never visible (AS-22, AS-23).

## Boundary check (post-design)

J02 reads no table, topic or queue. All cross-domain reads in the code under change go through R1 (`EntitlementsService.checkLimit`, `ShopQueryService.getShopsByIds`, `ProductStockService`) or R3 (events). Nothing here adds a foreign-table read.
