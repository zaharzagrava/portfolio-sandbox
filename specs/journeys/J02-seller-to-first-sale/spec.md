# Feature Specification: J02 — Seller to First Sale: a new seller registers, gets a verified shop, subscribes, lists a product that becomes searchable, sells it, receives the order webhook and appears on the leaderboard

**Feature Branch**: `J02-seller-to-first-sale` (spec directory `specs/journeys/J02-seller-to-first-sale`)

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Cross-domain journey J02: New seller registers, creates a shop, passes onboarding/KYC, subscribes to a plan, lists a product that becomes searchable, sells it, receives the order webhook, and appears on the leaderboard." Sources: constitution v3.1.0 (IV, VII, IX.7), `docs/architecture/domain-map.md`, `docs/architecture/debt-register.md` (D-7, D-8, D-11, D-12, D-15, D-16), the specs S01, S03, S04, S05, S17, S18, S32, S40, S43 and the sibling journey J01, `interview-prep/` notes on events and projections (outbox, idempotent consumers, read models) and the current code (see `gaps.md`).

## Scope

One person signs up, opens a shop, proves who they are, pays for a plan, lists one product, a buyer buys it, and the shop's own systems are told, while the shop shows up on the public leaderboard. Eleven domains take part. This journey proves only the **hand-offs between them**; every rule inside one domain is already proven by that domain's own spec and is referenced, never re-tested (see `test-plan.md`).

The chain, with the kind of hand-off at each arrow (constitution IV.3, IX.7):

```
visitor ─POST /auth/register, /auth/login─► identity
seller ─POST /shops─► tenancy ─same transaction─► outbox: tenancy.shop_created, tenancy.member_added
tenancy.events ─► identity (promote USER → SELLER, conditional, idempotent)                     [R3]
seller ─PUT steps, POST submit, POST documents─► seller-onboarding ─outbox: shop.onboarding_submitted─► tenancy (PENDING)
seller ─POST documents/:id/uploaded─► onboarding ─outbox command, SQS onboarding-documents─► extractor (Lambda) ─► LLM port (edge double)
onboarding (all documents APPROVED, or moderator resolves) ─outbox: shop.verified | shop.rejected─► tenancy (VERIFIED + payoutsEnabled | REJECTED)
owner ─POST /shops/:id/subscription (Idempotency-Key)─► billing ─same transaction─► invoice + job billing.charge-invoice
job ─► payment provider (edge double) ─► billing: invoice PAID, subscription ACTIVE ─outbox: billing.subscription_status_changed, billing.invoice_paid, billing.subscription_plan_changed
billing.events ─► billing/S18 (entitlements invalidated, rebuilt)   ─► tenancy (Shop.plan)                               [R3]
seller ─POST /shops/:id/products─► catalog ──R1──► billing (checkLimit maxProducts), tenancy (shop active)
catalog ─same transaction─► outbox: catalog.product_created (snapshot) ─► products.events ─► discovery projector (Elasticsearch) ; webhooks router ; leaderboards (category copy)
anonymous ─GET /products/search─► discovery (observable)                                                            [R3]
buyer ─J01 chain─► orders ──R1──► catalog.ProductStockService (stock −1) ─outbox: catalog.product_updated─► discovery (inStock=false)
orders ─outbox: order.paid─► orders.events ─► webhooks router ─FIFO SQS─► delivery worker ─signed POST─► shop's receiver
orders.events ─► leaderboards projector (Redis boards) ; tenancy.events ─► leaderboards (name, slug copy)
anonymous ─GET /leaderboards─► ; member ─GET /shops/:id/rank─► (observable)
```

In scope:

- The user-visible outcomes of the chain: account role, shop verification and plan, entitlements, product visibility in search, the webhook the shop receives, the shop's rank.
- The **eventual-consistency contract** of every asynchronous hop: maximum time to visibility on the local stack and how a client observes progress.
- The cross-domain failure modes: duplicate and out-of-order events, a consumer that is down and catches up, replay of a topic, the compensation paths (declined first charge, rejected application, suspended shop), retried requests with the same idempotency key.
- The **journey control surface** and provider doubles it relies on. The surface is the one J01 defines (jobs, consumers, clock); J02 adds job types and doubles (below) and restates only what it needs.
- The hand-offs that are missing or broken in the code today (`gaps.md`).

Out of scope (owners named):

- The buy chain after the order is paid (payment, ledger, settlement, payout, statement, buyer and seller notifications) → **J01**. J02 buys through the J01 chain and asserts only what the seller's shop needs: stock, webhook, rank.
- Questionnaire rules, document rules, extraction rules, review rules → **S04**; shop roles, invites, SSO → **S03**; plan prices, proration, dunning, renewal → **S17**; usage metering → **S18**; ranking arithmetic, periods, snapshots → **S40**; signature, retries, breaker, SSRF rules → **S43**; index mapping, ranking, facets, reindex → **S32**; product validation, versions, archive → **S05**.
- Seller notification mails (verified, rejected, receipts) → **S28**; they are not asserted here.
- Screens: onboarding wizard, billing, inventory, developer settings → **W04**. No capability owns a billing screen today (S17), so this journey has **no UI scenario**; it is an API journey.

## User Scenarios & Testing *(mandatory)*

### Notation and conventions

- People and things (all created by the test through public APIs with unique names, so journeys can share a stack): visitor `V` (becomes the seller), a second user `V2`, shop `S` (owned by `V`), moderator/admin `A` (a platform admin provisioned by the stack, see Provider doubles), buyer `U`, product `P` (price `1500` EUR minor units, quantity `1`, unique title `J02-<runId>-lamp`), receiver `R` (the test's own HTTPS server), webhook endpoint `E` (on `S`, events `product.created`, `order.paid`), plan price `Pr` = the cheapest active monthly shop price from `GET /plans` whose `maxProducts` is greater than the free tier's.
- No database, topic or queue is read by the test. A hand-off step is written **`[trigger] → [domain reacts] → [observable]`**. Triggers are: an API call, a domain event, an SQS task, a scheduled job. Observables are public API reads, the receiver `R`, or the control surface.
- **Waiting** is done only by polling an observable until it shows the expected state, with the deadline of the hop's contract (table below; deadline = 2 × maximum, poll interval 250 ms, scaled by `JOURNEY_TIME_FACTOR`). A fixed sleep is a test defect. Absence ("never") is asserted only after the same consumer reports `lag: 0` and the hop's maximum has elapsed on the stack clock.
- **Provider doubles** (system edge, local profile only, selected by configuration, refused at startup in production; constitution VII.2):
  - *Payment provider* (subscription charge and J01's order payment) answers by `paymentMethodRef` / `paymentMethodId`: `pm_test_visa` succeeds, `pm_test_declined` is a definite decline, `pm_test_timeout` never answers.
  - *Document extractor model* (S04's LLM port) answers by file content: the fixture `kyc-ok-*.pdf` set (business registration, bank statement, VAT certificate) is read as a valid document with high confidence; `kyc-unclear.pdf` is read with low confidence (goes to human review); `kyc-forged.pdf` is read as contradicting the questionnaire (rejected by rule). The fixtures live in `test/journeys/support/fixtures/` with their `sha256`.
  - *Platform admin*: the stack provisions one platform `ADMIN` at start from configuration (`BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`), local profile only; the test signs in through `POST /auth/login`.
  - *Webhook receiver `R`*: an HTTPS server owned by the test on an ephemeral port. The local profile lists it in the webhook sender's `allowedReceiverHosts` (host and port), accepted only outside production and validated at startup; the endpoint URL is registered through the public API like any other. `R` verifies each request with S43's reference verifier and records `Marketplace-Event-Id`, `Marketplace-Delivery-Id`, `Marketplace-Attempt`, and the body. `R` can be told to answer `200`, `500` or to hang.
- **Control surface** (J01's, admin role, local profile; see Cross-capability contracts): `POST /api/admin/jobs` + `GET /api/admin/jobs/:jobId`; `GET /api/admin/consumers/:group`, `…/pause`, `…/resume`, `…/replay {since}`; `GET|PUT /api/admin/clock`. The journey restores the clock and resumes every consumer in `afterAll`, even on failure.
- Every error is `application/problem+json` with a stable `code` (S54).

### Eventual-consistency contract (the hops)

Maximum time from the trigger until the result is visible **on the local stack** (single deployment of every process the chain needs: core, worker, projector, realtime gateway, document extractor; outbox relay interval ≤ 2 s; search index refresh ≤ 1 s). The owner of each hop must meet it; the journey tests wait on it.

| Hop | From → to | Visible through | Max | Owner |
|---|---|---|---|---|
| H1 | `tenancy.shop_created` → `V`'s role becomes `SELLER` | `GET /auth/me` (and the role claim of the next refreshed token) | 3 s | S01 |
| H2 | `shop.onboarding_submitted` → shop `verificationStatus: PENDING` | `GET /shops/:shopId` | 5 s | S03 |
| H3 | document `uploaded` → SQS task → extraction → document `APPROVED` or `NEEDS_REVIEW` | `GET /shops/:shopId/onboarding` (`documents[].status`) | 20 s | S04 |
| H4 | last required document approved (or moderator `APPROVE`) → `shop.verified` → shop `VERIFIED`, `payoutsEnabled: true` | `GET /shops/:shopId`; `GET /shops/:shopId/onboarding` (`status`) | 5 s | S03 (S04 for its own status: at once) |
| H5 | `shop.rejected` → shop `REJECTED`, `payoutsEnabled: false` | `GET /shops/:shopId` | 5 s | S03 |
| H6 | `POST …/subscription` accepted → charge job → invoice `PAID` and subscription `ACTIVE` | `GET /shops/:shopId/subscription`; `GET /shops/:shopId/invoices` | 5 s | S17 |
| H7 | `billing.subscription_status_changed` → entitlements of the new plan | `GET /shops/:shopId/subscription` (`entitlements`) | 5 s | S18 |
| H8 | `billing.subscription_plan_changed` → `Shop.plan` | `GET /shops/:shopId` | 5 s | S03 |
| H9 | `catalog.product_created` → document in the search index | `GET /products/search?q=<title>` | 10 s | S32 |
| H10 | `catalog.product_updated` (stock reaches 0, archive, restore) → index document | `GET /products/search`, `GET /shops/:shopId/products/search` | 10 s | S32 |
| H11 | `tenancy.shop_status_changed` (suspend, reinstate) → products hidden, shown | `GET /products/search` | 10 s | S32 |
| H12 | `catalog.product_created` → webhook `product.created` first delivery attempt | receiver `R`; `GET …/webhooks/:id/attempts?eventId=` | 10 s | S43 |
| H13 | `order.paid` → webhook `order.paid` first delivery attempt | receiver `R`; `GET …/webhooks/:id/attempts?eventId=` | 10 s | S43 |
| H14 | `order.paid` → leaderboard board and rank | `GET /shops/:shopId/rank`; `GET /leaderboards` | 5 s (poll until `200`, deadline 10 s per S40) | S40 |
| H15 | `tenancy.shop_created` / `shop_updated` → name and slug on the board | `GET /leaderboards` entry `name`, `slug` | 5 s | S40 |
| H16 | a consumer resumed or replayed → `lag: 0` | `GET /api/admin/consumers/:group` | 15 s | S53 |
| H17 | any job run through the control surface → finished | `GET /api/admin/jobs/:jobId` | 5 s to start | S49 |

`order.paid` itself and everything after it inside the buy chain are J01's hops H1–H11.

A consumer that is behind exposes its lag through `GET /api/admin/consumers/:group` (`lag`, `state`); a consumer at rest reports `lag: 0`.

Canonical consumer groups of this journey: `identity-seller-promotion` (S01, `tenancy.events`), `tenancy-shop-lifecycle` (S03, `shop-onboarding` and `billing.events`), `entitlements-invalidation` (S18, `billing.events`), `search-product-index` (S32, `products.events` and `tenancy.events`), `webhook-router` (S43, `orders.events` and `products.events`), `leaderboards` (S40, `orders.events`, `tenancy.events`, `products.events`), `product-cache-invalidator` (S05, `products.events`).

---

### User Story 1 — A visitor becomes a seller with a shop (Priority: P1)

A person registers, signs in and opens a shop. Moments later their account is a seller account, without them signing out, and the shop is theirs alone.

**Why this priority**: every later step is shop-scoped; a shop without a seller role, or a role promoted without a shop, breaks authorisation for the rest of the chain.

**Independent Test**: register, sign in, create the shop, poll `GET /auth/me`.

**Acceptance Scenarios**:

1. **AS-01** (register and open a shop) — **Given** a new e-mail, **When** (1) `V` calls `POST /auth/register` → *identity* → `202` with no tokens; (2) `V` calls `POST /auth/login` → `200` with `user.role: "USER"`; (3) `V` calls `POST /shops {name, slug}` with `Idempotency-Key: k-j02-0001` → *tenancy writes the shop, the owner membership and the directory row and appends `tenancy.shop_created` and `tenancy.member_added` in the same transaction* → `201 {id: S, plan: "STARTER", status: "ACTIVE", verificationStatus: "UNVERIFIED", payoutsEnabled: false}`; **Then** `GET /shops/mine` lists `S` with role `OWNER` at once.
2. **AS-02** (the role follows the shop, by event) — **Given** AS-01, **When** `tenancy.shop_created` → *identity's consumer promotes `USER` to `SELLER` (conditional, idempotent)* (H1), **Then** `GET /auth/me` shows `role: "SELLER"` within H1 and the token obtained by the next `POST /auth/refresh` carries `SELLER`; tenancy did not write the user's row (proven by the static gate AS-29).
3. **AS-03** (retried create, same key) — **Given** AS-01, **When** `V` repeats step (3) five times at once with the same key, then once more after the shop exists, **Then** every answer is `201` with the same shop id, `GET /shops/mine` lists one shop, and `V` holds one `OWNER` membership; the same key with a different `name` answers `422 idempotency_key_reused`.
4. **AS-04** (a stranger sees nothing) — **Given** `V2` signed in, **When** `V2` calls `GET /shops/S` and `GET /shops/S/onboarding`, **Then** both answer `404 shop_not_found` identical to an unknown id.
5. **AS-05** (identity consumer catches up) — **Given** group `identity-seller-promotion` paused, **When** a second visitor registers and creates a shop, **Then** after H1 the role is still `USER`, `GET /api/admin/consumers/identity-seller-promotion` shows `lag ≥ 1`, and the shop works (the owner can read it); **When** resumed, **Then** within H16 the role is `SELLER` once and `lag` is `0`.

---

### User Story 2 — The shop is verified through onboarding, and a rejection is final until resubmitted (Priority: P1)

The seller answers the questionnaire, submits it, uploads documents, and a model or a moderator decides. The shop becomes verified and payout-enabled, or rejected, and nobody but the owning domain wrote that state.

**Why this priority**: verification gates payouts and trust; the hand-off is the longest asynchronous chain of the journey.

**Independent Test**: onboard one shop with the approving fixtures; onboard another with the unclear fixture and a moderator.

**Acceptance Scenarios**:

1. **AS-06** (automatic approval) — **Given** AS-02 and the four questionnaire steps saved, **When** (1) `V` calls `POST /shops/S/onboarding/submit` → *onboarding records the application and appends `shop.onboarding_submitted` in its transaction* → `200 {submitted: true, submissionNo: 1, requiredDocuments}`; (2) `shop.onboarding_submitted` → *tenancy* → `GET /shops/S` `verificationStatus: "PENDING"` (H2); (3) for each required kind `V` calls `POST …/documents {kind, sha256, size, contentType}` and uploads to the returned URL, then `POST …/documents/:id/uploaded` → *onboarding appends the `onboarding.extract_document` command in its transaction; it reaches SQS `onboarding-documents`* → *the extractor, with the model double* → document `APPROVED` (H3); (4) when the last required document is approved → *onboarding appends `shop.verified`* → *tenancy* (H4); **Then** `GET /shops/S/onboarding` shows `status: "VERIFIED"`, `GET /shops/S` shows `verificationStatus: "VERIFIED"`, `payoutsEnabled: true`, and `tenancy.shop_verification_changed` was the only writer of those two fields (static gate AS-29).
2. **AS-07** (human review path) — **Given** a second shop `S2` whose bank statement is `kyc-unclear.pdf`, **When** the extractor routes the document to review → document `NEEDS_REVIEW` (H3) and `A` calls `GET /admin/onboarding/reviews` (the task is listed with `shopName` for `S2`) and `POST /admin/onboarding/reviews/:taskId/resolve {decision: "APPROVE"}` → *onboarding* → `{status: "APPROVED", shopVerified: true}` → `shop.verified` → *tenancy* (H4), **Then** `GET /shops/S2` is `VERIFIED` and a member of `S` (another shop) cannot read the review task (`403`); a role without admin gets `403` on the review routes.
3. **AS-08** (compensation: the application is rejected) — **Given** a third shop `S3` with `kyc-forged.pdf`, **When** `A` resolves its task `REJECT_APPLICATION` → *onboarding appends `shop.rejected`* → *tenancy* → `GET /shops/S3` `verificationStatus: "REJECTED"`, `payoutsEnabled: false` (H5), `GET /shops/S3/onboarding` `status: "REJECTED"`, **Then** the shop can still read itself and its owner can create no payout destination (S15 rule, referenced); a later `shop.verified` for an older `submissionNo` never lifts the rejection (version guard).
4. **AS-09** (duplicate and out-of-order events) — **Given** AS-06 completed and all observables recorded, **When** the operator replays `shop-onboarding` from the start for group `tenancy-shop-lifecycle` (so `shop.onboarding_submitted` is delivered again after `shop.verified` has been applied: older facts after newer state), **Then** `GET /shops/S` is unchanged (`VERIFIED`, `payoutsEnabled: true`, same `shopVersion`, which proves no second `tenancy.shop_verification_changed` was written), and `lag` is `0`.
5. **AS-10** (extractor down, then back) — **Given** the extractor process stopped (the stack's control for the worker host) or the queue consumer paused, **When** `V` marks the documents uploaded, **Then** documents stay `QUEUED`, `GET /shops/S/onboarding` stays `SUBMITTED` and the application is not lost; **When** the extractor starts again, **Then** each document is processed **once** (one model call per document, proven by S04) and the shop becomes `VERIFIED` within H3 + H4; the same `…/uploaded` call repeated changes nothing.
6. **AS-11** (crash between approval and verification) — **Given** every required document `APPROVED` but `shop.verified` not yet appended (the state a crash between the two steps leaves), **When** the onboarding sweep job runs through the control surface (`onboarding.verify-pending`), **Then** `shop.verified` is appended once and the shop is `VERIFIED` (H4); running the sweep again changes nothing.

---

### User Story 3 — The seller subscribes and the plan's limits apply, exactly once (Priority: P1)

The owner picks a plan, pays, and only after the first charge succeeds does the shop get the plan's entitlements. A declined card leaves the shop on the free tier.

**Why this priority**: a stale "yes" gives paid features away; a stale "no" blocks someone who just paid. Money and entitlements are the most sensitive hand-off of the first half.

**Independent Test**: subscribe with `pm_test_visa`, read entitlements; subscribe another shop with `pm_test_declined`.

**Acceptance Scenarios**:

1. **AS-12** (subscribe, charge, entitlements) — **Given** AS-06 and the free-tier limit `f` read from `GET /shops/S/subscription` (`subscription: null`, `entitlements.maxProducts = f`), **When** (1) the owner calls `POST /shops/S/subscription {priceId: Pr, paymentMethodRef: "pm_test_visa"}` with `Idempotency-Key: k-j02-0002` → *billing creates the subscription, the first invoice and the job `billing.charge-invoice` in one transaction; no provider call in the request* → `201` (no `paymentMethodRef` in the body) and the entitlements are still the free tier; (2) the charge job → *billing, payment double* → invoice `PAID` (`GET /shops/S/invoices`), subscription `ACTIVE` (H6), and `billing.invoice_paid`, `billing.subscription_status_changed`, `billing.subscription_plan_changed` are appended in that transaction; (3) `billing.subscription_status_changed` → *S18 invalidates and rebuilds the entitlement view* (H7); (4) `billing.subscription_plan_changed` → *tenancy* (H8); **Then** `GET /shops/S/subscription` shows `ACTIVE` with `entitlements.maxProducts = m > f`, and `GET /shops/S` shows the plan of `Pr` (not `STARTER`). At no instant before step (2) did the entitlements show `m`.
2. **AS-13** (retried subscribe, same key) — **Given** AS-12, **When** step (1) is sent five times at once with the same key and again after `ACTIVE`, **Then** every answer is the first `201` (same subscription id), `GET /shops/S/invoices` lists one invoice, the receiver of the payment double saw one charge (observable: one `PAID` invoice and one `billing.invoice_paid` effect), and the same key with another `priceId` answers `422 idempotency_key_reused`; without the header `422 idempotency_key_required`.
3. **AS-14** (compensation: first charge declined) — **Given** the verified shop `S2` of AS-07, **When** the owner subscribes with `pm_test_declined` → charge job → *billing: definite decline* → invoice stays unpaid, `billing.invoice_payment_failed` is appended with the reason, **Then** `GET /shops/S2/subscription` never shows the paid entitlements (`maxProducts = f` throughout), a product create beyond `f` stays refused (AS-17), and the owner can fix it: `PUT /shops/S2/subscription/payment-method {paymentMethodRef: "pm_test_visa"}`, the clock advanced by the first dunning delay and `POST /api/admin/jobs {type: "billing.run"}` → invoice `PAID`, subscription `ACTIVE`, entitlements `m` (H6, H7), exactly one charge succeeded.
4. **AS-15** (entitlements cache catches up) — **Given** group `entitlements-invalidation` paused and a fresh shop `S4` already reading the free tier, **When** `S4` subscribes (`pm_test_visa`) and the charge succeeds, **Then** the invoice is `PAID` and `GET …/subscription` shows `ACTIVE`; the entitlements stay the free tier while the consumer is down and `lag ≥ 1` (a stale answer is allowed for at most the cache lifetime, then the read repairs itself from the committed state); **When** resumed, **Then** within H7 the entitlements are `m`, once.
5. **AS-16** (duplicate and replayed billing events) — **Given** AS-12 completed, **When** `billing.events` is replayed from the start for groups `entitlements-invalidation` and `tenancy-shop-lifecycle` (older versions arrive after newer state), **Then** entitlements and `Shop.plan` are unchanged and `lag` is `0`.

---

### User Story 4 — A listed product is bounded by the plan and becomes searchable (Priority: P1)

The seller lists a product; if the plan allows it, anyone can find it by search a few seconds later; if the plan does not, the seller is told why.

**Why this priority**: listing is the seller's core action and search is how buyers find it; the entitlement check and the index are two different domains reacting to one product.

**Independent Test**: create a product, poll search; fill the free tier, hit the limit, subscribe, create again.

**Acceptance Scenarios**:

1. **AS-17** (the plan limit applies) — **Given** a fresh verified shop `S5` on the free tier with limit `f` and `f` products created through `POST /shops/S5/products` (each `201`), **When** the owner creates product `f + 1`, **Then** `409 plan_limit_reached {key: "maxProducts", limit: f}`, no product exists for it (`GET /shops/S5/products` count is `f`), and no `catalog.product_created` exists for it (no webhook, no index document); **When** `S5` subscribes (AS-12 steps) and the product is created again with a new key, **Then** `201`. (`checkLimit` rule itself: S18; the refusal rule inside catalog: S05; here: the R1 hand-off from S05 to S18 and its cache invalidation.)
2. **AS-18** (list, then find) — **Given** AS-12 and a webhook endpoint `E` on `S` subscribed to `product.created` (AS-24), **When** (1) the owner calls `POST /shops/S/products {title, description, category, priceMinor: 1500, currency: "EUR", quantity: 1}` with `Idempotency-Key: k-j02-0003` → *catalog checks shop activity (R1 tenancy) and the product limit (R1 billing), writes the product and appends `catalog.product_created` (full snapshot, key `productId`) in one transaction* → `201`; (2) `catalog.product_created` → *discovery's projector indexes the snapshot, never the table* (H9) → `GET /products/search?q=<unique title>` (anonymous) returns an item with `id = P`, `shopId = S`, `priceMinor: 1500`, `inStock: true`, and `GET /products/P` already answered `200` at once; (3) the same event → *webhooks' router* → `product.created` delivered to `R` (H12) (AS-24); **Then** no search hit exists for another shop's query of that title, and the seller's own list `GET /shops/S/products/search?q=` finds it.
3. **AS-19** (retried create, same key) — **Given** AS-18, **When** step (1) is sent five times at once with the same key, **Then** every answer is `201` with the same `P`, the shop has one product with that title, search returns one hit, and `R` receives one `product.created` event id.
4. **AS-20** (index consumer down, then catch-up) — **Given** group `search-product-index` paused, **When** the owner creates product `P2`, **Then** `GET /products/P2` answers `200` and the seller's list shows it, search does **not** return it after H9, and `lag ≥ 1`; **When** resumed, **Then** within H16 + H9 search returns it **once** and `lag` is `0`.
5. **AS-21** (edits and archive reach search, in order) — **Given** AS-18, **When** the owner `PATCH`es the title (with `expectedVersion`), then archives the product, then restores it, in quick succession → *catalog appends three events with increasing `productVersion`* → *discovery applies them with a version guard* (H10), **Then** the search result converges to the restored product with the final title and no stale hit exists for the old title; replaying `products.events` from the start for `search-product-index` leaves search identical (older versions arrive after newer ones and are discarded).
6. **AS-22** (suspension hides, reinstatement shows) — **Given** AS-18, **When** `A` calls `POST /admin/shops/S/suspend {reason}` → *tenancy appends `tenancy.shop_status_changed`* → *discovery's shop-state copy* (H11), **Then** `P` disappears from `GET /products/search` and `POST /checkout` of `P` is refused with the shop-not-active error (S10 rule, referenced); **When** `A` reinstates, **Then** `P` is searchable again within H11.
7. **AS-23** (events that arrive before their shop) — **Given** `search-product-index` paused and the shop-state copy for a brand new verified shop not yet applied, **When** the shop is created, a product is created and the consumer is resumed so that `catalog.product_created` may be handled before `tenancy.shop_created`, **Then** after `lag: 0` the product is searchable exactly once and never visible while its shop's state is unknown or inactive (no hit appears and then disappears).

---

### User Story 5 — The first sale reaches the seller's systems and the leaderboard (Priority: P1)

A buyer buys the product. The shop's own server is told with a signed message, the stock goes to zero everywhere it is shown, and the shop appears on the public leaderboard.

**Why this priority**: this is the outcome the seller subscribed for.

**Independent Test**: buy `P` through the J01 chain, wait on the receiver, the search and the rank.

**Acceptance Scenarios**:

1. **AS-24** (webhook endpoint for the shop) — **Given** AS-12, **When** the owner calls `POST /shops/S/developers/webhooks {url: R, events: ["product.created", "order.paid"]}` → *developer-platform* → `201 {id: E, secret, status: "enabled"}`, **Then** the secret is shown once, `GET …/webhooks/E` never returns it, a staff member of `S` gets `403` (permission `webhooks.manage`: S43), and a member of another shop gets `404`.
2. **AS-25** (the sale, end to end) — **Given** AS-18 with `P` (quantity `1`), `E` active, buyer `U` signed in, **When** `U` runs the J01 chain for `P` (checkout with key `k-j02-0004`, intent with `pm_test_visa`) until the order is `PAID` → *orders reserved the stock through catalog's `ProductStockService` (R1), so catalog appended `catalog.product_updated` with `quantity: 0, inStock: false` in the same transaction as the decrement*; **Then** (a) `GET /products/search?q=` shows `inStock: false` for `P` within H10 and `GET /products/P` shows `quantity` consistent with it (cache repaired by the event, not by TTL); (b) `R` receives exactly one `order.paid` request within H13, signature valid, `Marketplace-Event-Type: order.paid`, `Marketplace-Attempt: 1`, body `{id, object: "event", type: "order.paid", created, api_version, resource_version, data: {object}}` where `data.object` carries only `S`'s part of the order (its `shopOrders` entry and its lines; `totalMinor` = `S`'s subtotal; no other shop's lines, no buyer id beyond the order reference), amounts from `lineTotalMinor`; (c) `GET /shops/S/developers/webhooks/E/attempts?eventId=<id>` lists one attempt with `ok: true`; (d) `GET /shops/S/rank` answers `200` with `rank ≥ 1`, `of ≥ 1`, `revenueMinor` equal to `S`'s subtotal and `GET /leaderboards?period=week` contains an entry `shopId = S` with `name` and `slug` of `S` and no revenue (H14, H15).
3. **AS-26** (two-shop order, only the right shop is told and ranked) — **Given** AS-25 and a second shop `Sx` with an endpoint `Ex` subscribed to `order.paid`, **When** a new order `O2` contains a product of `S` and a product of `Sx` and is paid, **Then** `R` receives one `order.paid` for `O2` carrying only `S`'s lines, `Rx` receives one carrying only `Sx`'s lines, both with different event ids derived from the same order event, and each shop's rank revenue grows by its own subtotal only.
4. **AS-27** (receiver fails, then recovers, no duplicate effect) — **Given** `R` answering `500`, **When** an order of `S` is paid, **Then** the first attempt fails (`ok: false` in `attempts`), the delivery is retried on the schedule (the clock is advanced through the control surface by the first retry delay and `webhooks.retry` is run) and, after `R` answers `200`, the **same event id** is delivered once successfully; `R` deduplicates on `id` and sees one effect; a manual replay `POST …/events/:eventId/replay` with `Idempotency-Key` marks `Marketplace-Replay: true`, same `id`.
5. **AS-28** (webhook router or leaderboard consumer down, then catch-up) — **Given** group `webhook-router` paused, **When** an order of `S` is paid, **Then** `R` receives nothing and `lag ≥ 1` while the order, stock and rank are right; **When** resumed, **Then** within H16 + H13 `R` receives exactly one `order.paid` (same `id` it would have had); **Given** group `leaderboards` paused instead, **Then** the rank does not move until resumed, then moves **once** by the order's subtotal.
6. **AS-29** (duplicate and replayed order events) — **Given** AS-25 and all observables recorded (`R`'s received ids, rank and `revenueMinor`, search document, stock), **When** the operator replays `orders.events` from the journey start for groups `webhook-router` and `leaderboards` and `products.events` for `webhook-router`, `search-product-index` and `product-cache-invalidator`, **Then** `R` receives no new event id (a re-routed event reuses its id and is not delivered again after a recorded success), `revenueMinor` and `rank` are unchanged, the search document is unchanged, and every group reports `lag: 0`.
7. **AS-30** (renaming the shop reaches the board) — **Given** AS-25, **When** the owner calls `PATCH /shops/S {name: "<new>"}` → *tenancy appends `tenancy.shop_updated`* → *leaderboards' copy* (H15), **Then** the board entry shows the new name and the same rank; the search item's data does not change (no shop name in an item).
8. **AS-31** (a cancelled order is not a sale) — **Given** a product `P3` of `S` and `E` subscribed to `order.paid`, **When** the buyer's order for `P3` is declined or expires (J01 AS-17, AS-19), **Then** `R` receives no `order.paid`, `S`'s rank revenue is unchanged and the stock of `P3` is restored in search (`inStock: true`) within H10.

---

### User Story 6 — Operators and engineers can see progress, and the boundaries hold (Priority: P3)

**Acceptance Scenarios**:

1. **AS-32** (every hop is observable) — **Given** the whole journey ran, **When** the metrics endpoint is read, **Then** counters exist and moved for: shops created, onboarding submitted and verified, invoices paid, products indexed, webhook deliveries (`ok` and failed), leaderboard events applied; every consumer group of the journey reports `lag: 0` and `state: RUNNING`; every log line of the journey carries a `requestId` or `traceId` and the `shopId` where one applies; no secret, token, document content, card reference or webhook secret appears.
2. **AS-33** (approved paths only) — **Given** the repository, **Then** the static gates pass: `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` for the domains `identity`, `tenancy`, `seller-onboarding`, `billing`, `catalog`, `discovery`, `developer-platform`, `seller-insights`, `check:module-graph` (every process boots) and `check:model-registry`; identity never writes `Shop`, tenancy never writes `User`, onboarding never writes `Shop`, catalog imports no `discovery`, no domain reads `Product` or `Shop` outside its owner.

### Edge Cases

- A product created while the shop's verification is still `PENDING`: allowed (listing is not gated on KYC; the money gate is the payout, S15); the journey creates its product after verification only because that is the seller's path.
- `shop.verified` arriving at tenancy before `shop.onboarding_submitted`: tenancy converges to `VERIFIED` (proven in S03); AS-09 reproduces it through replay only.
- The shop is subscribed before verification: allowed; entitlements do not depend on KYC.
- The clock moves during the journey: the journey owns the clock for its whole run and restores it at the end; sessions are re-created after each move (tokens may expire).
- Two journeys on one stack: separate users, shops and unique titles; the clock, consumer pause and `allowedReceiverHosts` are global, so journey files run serially (`maxWorkers: 1`) and always resume consumers and reset the clock in `afterAll`.
- A search query matching other tests' products: every assertion uses the journey's unique title and `shopId`.
- A purchase of the last unit by two buyers at once: stock invariant, proven in S10 / S05; not repeated here.
- Rate limits: register and login are limited per IP and per account (S50). The journey uses one account per actor, signs in once, refreshes tokens, and the stack's local profile sets the journey run's address on the limiter's allow list; a `429` is a test defect, not a retry case.

## Requirements *(mandatory)*

### Functional Requirements

**The chain**

- **FR-001**: Registration MUST NOT issue tokens or reveal whether an address exists (`202`); sign-in is a separate call (AS-01).
- **FR-002**: Creating a shop MUST write the shop, the owner membership and the directory row and append `tenancy.shop_created` and `tenancy.member_added` in one transaction; no domain other than tenancy MAY write `Shop` and no domain other than identity MAY write `User` (AS-01, AS-02, AS-33).
- **FR-003**: A seller's role MUST be promoted by identity's consumer of `tenancy.shop_created`, conditional (`USER` only) and idempotent; the new role MUST be visible on `GET /auth/me` within H1 and in the next refreshed token (AS-02, AS-05).
- **FR-004**: Onboarding MUST announce its decisions only through `shop.onboarding_submitted`, `shop.verified` and `shop.rejected` events appended in the deciding transaction; tenancy MUST derive `verificationStatus` and `payoutsEnabled` from them, tolerate duplicates and any order using `submissionNo` and `shopVersion`, and publish `tenancy.shop_verification_changed` (AS-06, AS-08, AS-09).
- **FR-005**: The command to extract a document MUST be appended in the transaction that marks it uploaded and reach SQS through the outbox; extraction MUST be idempotent and at most one model call per document (AS-06, AS-10).
- **FR-006**: A crash between "all documents approved" and "shop verified" MUST be repaired by a scheduled sweep (AS-11).
- **FR-007**: Subscribing MUST require an `Idempotency-Key`, create the subscription, the first invoice and the charge job in one transaction, and make no provider call in the request; the response MUST NOT contain the payment method reference (AS-12, AS-13).
- **FR-008**: Paid entitlements MUST be granted only after the first charge succeeded; a declined first charge MUST leave the free tier in force and notify through `billing.invoice_payment_failed` (AS-12, AS-14).
- **FR-009**: Billing MUST append `billing.invoice_paid`, `billing.subscription_status_changed` (with `from`, `planCode`, `subscriptionVersion`) and, for shops, `billing.subscription_plan_changed` (with a per-shop `version`) in the transaction that changes the state; S18's consumer MUST invalidate and rebuild the entitlement view from the committed state and ignore older versions; tenancy MUST update `Shop.plan` from the plan event (AS-12, AS-15, AS-16).
- **FR-010**: Creating a product MUST check, through R1, that the shop is active (tenancy) and that the shop's product count is below `maxProducts` (billing); a refusal is `409 plan_limit_reached {key, limit}` and writes nothing (AS-17).
- **FR-011**: Creating, updating, archiving and restoring a product, and every stock change (reservation, release, sale), MUST append the matching `catalog.product_*` snapshot event in the same transaction, through catalog's own services only; events carry `shopId`, `status`, `quantity`, `inStock`, `isSandbox`, `productVersion` (AS-18, AS-21, AS-25).
- **FR-012**: Search MUST be built only from those events (R3), hide products of shops that are not active, and expose `shopId` on each item (AS-18, AS-22, AS-23).
- **FR-013**: A sale of a shop's product MUST be delivered to that shop's endpoints as a signed `order.paid` message containing only that shop's part of the order, exactly one event id per (order, shop), at least once on the wire, and MUST be visible in the attempts API (AS-25, AS-26, AS-27).
- **FR-014**: A shop MUST appear on the leaderboard from its first paid order with the revenue of its own lines, and the board MUST show the shop's current name and slug from tenancy's events and no revenue figure (AS-25, AS-30).
- **FR-015**: A sale for a cancelled, declined or expired order MUST never create a webhook, a rank or a board entry (AS-31).

**Failure modes**

- **FR-016**: Every consumer of the chain MUST be idempotent (inbox, unique key on `eventId`, or version-guarded upsert), validate its payload, and dead-letter poison messages without blocking (constitution IV.5) (AS-09, AS-16, AS-29).
- **FR-017**: Events of one aggregate MUST be keyed by the aggregate id, and consumers MUST discard an event whose version is lower than the one applied (AS-09, AS-21).
- **FR-018**: A consumer that is down MUST lose nothing: after resuming, every fact is applied once, and its lag is visible (AS-05, AS-15, AS-20, AS-28).
- **FR-019**: Every request that creates something (`POST /shops`, `POST …/subscription`, `POST …/products`, webhook replay) MUST be safe to retry with its key: a retry changes nothing and returns the original answer (AS-03, AS-13, AS-19).
- **FR-020**: A rejected application, a declined first charge and a suspended shop MUST each leave the dependent domains consistent: no verified flag, no paid entitlements, no searchable product (AS-08, AS-14, AS-22).

**Observability and control (journey support)**

- **FR-021**: Every hop in the contract table MUST meet its maximum time on the local stack and be observable through the API named in the table (all scenarios).
- **FR-022**: The control surface of J01 MUST also run `billing.run`, `onboarding.verify-pending`, `webhooks.retry`, `search.reindex` on demand (allow-list), and the local stack MUST run every process the journey needs, including the document extractor, in one deployment.
- **FR-023**: The local profile MUST provide the provider doubles, the admin bootstrap and the receiver allow-list of the notation, each refused at startup in production.
- **FR-024**: The journey MUST drive and observe only through public APIs, the receiver `R` and the control surface; it MUST resume paused consumers and reset the clock even when it fails.

**Safety**

- **FR-025**: A user MUST see only their own shop's onboarding, subscription, invoices, products-in-management, webhooks and rank (`404` for another shop, `403` for a role without the permission); the public search, board and product page expose public fields only (spot-checked in AS-04, AS-07, AS-24).
- **FR-026**: Events, logs and webhook bodies MUST NOT carry document content, payment method references, webhook secrets or the buyer's identity beyond what a consumer needs.

### Key Entities

- **Account / shop / membership**: the person, the shop they own, their role in it.
- **Application / document / review task**: the onboarding submission, its uploaded documents, a moderator's task.
- **Subscription / invoice / entitlements**: the plan, the charge, and the limits derived from the plan.
- **Product / index document**: the listing and its searchable copy.
- **Webhook endpoint / event / attempt**: the shop's receiver, a message to it, and each try.
- **Board entry / rank**: a shop's place for a week or month.
- **Consumer group**: a named subscription of one domain to topics, with state and lag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From shop creation to the account showing the seller role: at most 3 seconds on the local stack in 99% of runs, with no sign-out required.
- **SC-002**: From the last approved document to the shop showing verified and payout-enabled: at most 5 seconds in 99% of runs; from submission to verified with the approving fixtures: under 30 seconds.
- **SC-003**: From a successful first charge to the plan's limits applying and the shop showing the plan: at most 5 seconds in 99% of runs; in 100% of runs no plan feature is available before the first charge succeeded.
- **SC-004**: From a product being listed to it appearing in public search: at most 10 seconds in 99% of runs, with 0 listings visible for a shop that is suspended or whose plan limit refused them.
- **SC-005**: From an order being paid to the seller's server receiving the signed message and to the rank showing: at most 10 seconds each in 99% of runs.
- **SC-006**: Under any retry or replay pattern of the journey (same key five times at once, topics replayed, consumers paused and resumed), exactly 1 shop, 1 subscription, 1 invoice paid, 1 product, 1 search document, 1 webhook event id per (order, shop) and 1 revenue increment exist: 0 duplicates in 100% of runs.
- **SC-007**: With any one consumer of the journey paused during its step and resumed afterwards, 0 facts are lost and 0 are applied twice; the lag returns to 0 within 15 seconds of resuming.
- **SC-008**: The journey runs from a clean local stack to green in under 10 minutes with 0 fixed sleeps.

## Assumptions

- Every default below is also a line in `questions.md`; those that change an existing contract are tagged `[BREAKING]` there.
- **Decision policy**: where the codebase and the notes disagree, the production-grade option wins (events through the outbox, R1/R3 only, version-guarded consumers, idempotency keys on creating calls), because there are no external clients to keep compatible.
- **Registration returns `202` and no tokens** (S01), so the journey signs in afterwards.
- **The role follows the shop by event**, not by a cross-domain write; the short window before H1 is accepted, and authorisation of shop routes never uses the global role (only shop membership).
- **Verification is decided only by seller-onboarding** and mirrored by tenancy from events; subscribing and listing are **not** gated on verification (billing and catalog stay independent of onboarding). The gate that matters for money is payout (`payoutsEnabled`, S15).
- **Entitlements follow the first successful charge**, not the subscribe call; a trial (a price with trial days, S17) is a separate S17 rule and is not used by this journey.
- **The product-count limit is enforced by catalog** calling `EntitlementsService.checkLimit` (R1), failing closed when entitlements are unavailable (`503 entitlements_unavailable`); a free tier of `f` products applies without a subscription.
- **Search is eventually consistent** (S32: 10 s) and the seller's own list is read-your-write; "searchable" always means public search.
- **Webhook payloads are shop-sliced** from `shopOrders` and `lineTotalMinor`; event ids are deterministic per (source event, shop) so replays are recognisable and receivers can deduplicate.
- **The leaderboard has no minimum**: any shop with a paid order in the period is ranked (S40); a shop with no paid order answers `404 not_ranked`.
- **One currency** (`EUR`); amounts are illustrative, assertions are relational wherever a price, limit or rate is configurable.
- **No UI scenario**: no capability owns a billing screen (S17) and W04 owns the others; this is an API journey.
- A journey owns the stack clock while it runs; journeys run serially.

## Cross-capability contracts

Searched before writing: `grep -rl` over `specs/domains specs/web specs/journeys` for `J02` and `journeys`. Contracts the earlier specs require from this journey, and how they are honoured:

- **S03** (spec:32): cross-domain journey **J02**; the shop switcher and roles are W04's. Honoured: AS-01 to AS-05, AS-08, AS-22, AS-30. S03 also asks S01 to promote on `tenancy.shop_created` (honoured: AS-02, AS-05).
- **S04** (spec:31): the journey names the seller side with W04 and guarantees only API contracts. Honoured: AS-06 to AS-11.
- **S17** (spec:407): after `POST /shops/:shopId/subscription` returns `201` and the charge job ran, `GET /shops/:shopId/subscription` shows `ACTIVE` and the plan's entitlements within 5 seconds (honoured: H6, H7, AS-12); S17 names the file `test/journeys/seller-to-first-sale.spec.ts` and a UI-less journey (**differs** on the file name: `[CONTRACT]` in `questions.md`).
- **S18** (spec:67): "S17's J02 promises the plan within 5 seconds of subscribing" (honoured: H7, AS-12, AS-15).
- **S05** (spec:33): cross-domain journeys J02 and J04 (honoured: AS-17 to AS-25). **S32** (spec:385): J02 consumes `GET /products/search` with `{searchId, mode, items[{id, shopId, …}], total, nextCursor, degraded}` (honoured: AS-18; assertions use `items[].id`, `shopId`, `priceMinor`, `inStock`).
- **S43** (spec:333, 336): J02 consumes the dashboard API under `/api/shops/:shopId/developers` and "receives the order webhook" with headers and body per the outbound contract (honoured: AS-24 to AS-27).
- **S40** (spec:327, 328, questions:36): J02 may poll `GET /shops/:shopId/rank` until `200`, at most 10 s after payment; boards within 5 s p99 (honoured: H14, AS-25).
- **S29** (spec:34): names J02 as an owner of seller gallery journeys; no photo step is in this journey (nothing required of J02).
- **J01**: "J02 proves onboarding itself" and the fixture of a verified, payout-enabled shop through S04's public routes with the extractor double (honoured: AS-06, AS-07 define the fixtures `sellerFixture` re-uses).

**Provides** (J02 has no runtime exports; it provides tests, fixtures and a timing contract):

- `packages/backend/test/journeys/seller-to-first-sale.journey-spec.ts` (top-level `describe` "Journey J02: seller to first sale").
- `packages/backend/test/journeys/support/` additions to J01's kit: `sellerFixture` (extended: register, shop, onboarding with the document fixtures, subscription, product, endpoint), `webhookReceiver` (HTTPS server, S43 reference verifier, scripted answers), `fixtures/kyc-*.pdf` with their `sha256`, and `waitForContract(hop, probe)` rows H1–H17.
- **The hop table** under "Eventual-consistency contract": H1–H17 with maximum times; owners listed there must not exceed them.
- **The canonical consumer-group names** listed there.

**Requires** (owner and exact shape assumed):

- **S01 (identity)**: `POST /auth/register` → `202 {status: "accepted"}`; `POST /auth/login` → `200 {accessToken, refreshToken, sessionId, user: {id, email, role}}`; `POST /auth/refresh`; `GET /auth/me` → `{id, email, role}`; consumer group **`identity-seller-promotion`** on `tenancy.events` for `tenancy.shop_created` (conditional `USER → SELLER`, inbox by `eventId`); startup provisioning of one platform `ADMIN` from `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` (local profile only); a rate-limit allow-list for the journey run on the local profile.
- **S03 (tenancy)**: `POST /shops {name, slug}` with optional `Idempotency-Key` (replay returns the original `201`, `422 idempotency_key_reused` on a different body) → `201 shopSchema`; `GET /shops/mine`; `GET /shops/:shopId` → `shopSchema` + `myRole`, with `plan`, `verificationStatus`, `payoutsEnabled`, `status`; `PATCH /shops/:shopId {name}`; `POST /admin/shops/:shopId/suspend|reinstate`; events `tenancy.shop_created|shop_updated|shop_status_changed|shop_verification_changed|shop_plan_changed` keyed by `shopId`; consumer group **`tenancy-shop-lifecycle`** on `shop-onboarding` (`shop.onboarding_submitted`, `shop.verified`, `shop.rejected`) and on `billing.events` (`billing.subscription_plan_changed`), version-guarded; `ShopQueryService.getShopsByIds` (R1) for the active check.
- **S04 (onboarding)**: the routes of S04's Provides (`PUT …/steps/:step`, `GET …/onboarding` with `status`, `submissionNo`, `POST …/submit`, `POST …/documents`, `POST …/documents/:documentId/uploaded`, `GET /admin/onboarding/reviews`, `POST …/resolve {decision: APPROVE | REJECT | REJECT_APPLICATION}`); events on topic `shop-onboarding` keyed by `shopId`: `shop.onboarding_submitted {shopId, submissionNo, …}`, `shop.verified {shopId, submissionNo, verifiedAt}`, `shop.rejected {shopId, submissionNo, rejectedAt, reasonCode}`; the extract command through the outbox to SQS `onboarding-documents`; job `onboarding.verify-pending` (sweep: documents all approved but application not verified); the extractor model double by fixture content (S46 port, local profile); the extractor hosted in the local deployment.
- **S17 (billing)**: `GET /plans` → catalog with `maxProducts` per plan; `POST /shops/:shopId/subscription` (`Idempotency-Key` required, no `paymentMethodRef` in the response) → `201 subscriptionSchema`; `GET /shops/:shopId/subscription` → `{subscription, entitlements}`; `GET /shops/:shopId/invoices`; `PUT /shops/:shopId/subscription/payment-method`; events `billing.invoice_paid`, `billing.subscription_status_changed {subscriptionId, subjectType, subjectId, status, from, planCode, subscriptionVersion}`, `billing.subscription_plan_changed {shopId, plan, version}`, `billing.invoice_payment_failed`, appended in the state-changing transaction; paid entitlements only after the first successful charge; the payment double by `paymentMethodRef`; job `billing.run`; charge currency from the invoice.
- **S18 (entitlements)**: consumer group **`entitlements-invalidation`** on `billing.events` (inbox by `eventId`, ignores older `subscriptionVersion`); `EntitlementsService.checkLimit('SHOP', shopId, 'maxProducts', current) → {allowed, limit, remaining}` (R1); entitlements `maxProducts` readable on `GET /shops/:shopId/subscription`.
- **S05 (catalog)**: `POST /shops/:shopId/products` (`products.write`, optional `Idempotency-Key`) → `201 productMemberSchema`, `409 plan_limit_reached {key, limit}`; `GET /shops/:shopId/products`; `PATCH …/:productId {expectedVersion, …}`; `POST …/archive|restore`; `GET /products/:productId`; events `catalog.product_created|updated|archived|restored|deleted` on `products.events` keyed `productId` with the snapshot payload of S05 and `productVersion`; stock changes through `ProductStockService.applyStockDelta` emit `catalog.product_updated`; `ProductCommandService.create` calls `EntitlementsService.checkLimit` and `ShopQueryService.getShopsByIds` (R1).
- **S32 (discovery)**: `GET /products/search` → `productSearchResponseSchema` (`items[].id|shopId|title|priceMinor|currency|inStock`); `GET /shops/:shopId/products/search`; consumer group **`search-product-index`** on `products.events` and `tenancy.events` (shop state copy), version-guarded, index refresh ≤ 1 s on the local profile; `GET /admin/search/index` (`projectionLagSeconds`); job `search.reindex`; hides products of non-active shops.
- **S43 (developer-platform)**: dashboard API of S43's Provides under `/api/shops/:shopId/developers` with `webhooks.manage`; event types `product.created`, `order.paid`; outbound headers and body of S43's contract; consumer group **`webhook-router`** on `orders.events` and `products.events` (shop-sliced from `shopOrders`, deterministic `evt_` id per (event, shop), inbox, zod); `GET …/webhooks/:id/attempts?eventId&ok`; `POST …/events/:eventId/replay` (`Idempotency-Key`); delivery worker hosted in the local deployment; `allowedReceiverHosts` (host and port) local-profile setting; job `webhooks.retry`; reference verifier exported to tests.
- **S40 (seller-insights)**: `GET /leaderboards` → `leaderboardPageSchema` (no revenue; `slug`, `name` from tenancy events); `GET /shops/:shopId/rank` (`ShopScoped('shop.read')`) → `shopRankSchema`, `404 not_ranked`; consumer group **`leaderboards`** on `orders.events`, `tenancy.events`, `products.events` (idempotent per `orderId`).
- **S10 / S13 / J01**: the J01 purchase chain; `order.paid {orderId, userId, totalMinor, currency, paymentRef, paidAt, lines[{lineId, productId, shopId, category, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders[{shopOrderId, shopId, subtotalMinor}], orderVersion}`; stock reserved and released through `ProductStockService` (R1); `order.cancelled` and `order.refunded` with `shopIds`.
- **S49 (jobs) / S53 (consumers) / S54 (clock)**: J01's control surface; the allow-list gains `billing.run`, `onboarding.verify-pending`, `webhooks.retry`, `search.reindex`.
- **S50 (rate limits)**: a separate policy for `POST /auth/register` (not `auth.login.ip`).
