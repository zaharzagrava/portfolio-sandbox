# Feature Specification: J05 — Engagement loop: follow a shop, see its new product in the feed, discuss it, share an affiliate link that converts, and see the purchase in recommendations, trending and A/B results

**Feature Branch**: `J05-engagement-loop` (spec directory `specs/journeys/J05-engagement-loop`)

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Cross-domain journey J05: A buyer follows a shop, sees its new product in the feed, discusses it, shares an affiliate link that converts, and the purchase shows up in recommendations, trending, and A/B experiment results." Sources: constitution v3.1.0 (IV, VII, IX.7), `docs/architecture/domain-map.md`, `docs/architecture/debt-register.md` (D-7, D-8, D-12), the specs S26, S25, S37, S34, S35, S39, S10, S28 and the sibling journeys J01–J04, `interview-prep/10-system-design/05-social-and-content.md` §8–§11 (short links, hybrid fan-out feed, comments), `09-data-and-infrastructure.md` §31–§32 (server-side conversion events through the outbox, top-K), and the current code of the domains `community`, `marketing`, `discovery`, `experimentation`, `orders`, `catalog` (see `gaps.md`).

## Scope

A seller publishes a product. A buyer who follows the shop sees it in their feed, starts a discussion about it, and shares a short link. A friend follows the link, buys, and the link's owner is credited with the conversion. The purchase then feeds three read models: "bought together" recommendations, trending, and the results of an A/B experiment. Six domains and the shared platform take part. This journey proves only the **hand-offs between them**; each domain's own rules are already proven by its capability spec and are referenced, never re-tested (see `test-plan.md`).

The chain, with the kind of hand-off at each arrow (constitution IV.3, IX.7):

```
buyer B ─POST /follow/shop:S─► community (follow graph, both directions)
seller O ─product created (J02 fixture)─► catalog ─same transaction─► outbox catalog.product_created ─products.events─►
        community product projector (own product copy, R3) ─► feed item new_product (stored once) ─announce feed.item_published─►
        fan-out consumer ─► B's timeline                                  ─ B: GET /feed                           [R3]
B ─POST /boards/P/posts─► community (discussions) ──R1──► catalog (board = product, writes only)
        ─record discussion.post_created─► discussion.events ─► feed projector ─► post item for B's followers (W)   [R3]
        feed read hydration ──R1──► DiscussionQueryService.getPostsByIds (deleted post vanishes at once)          [R1]
O ─POST /posts/:id/comments─► community ─discussion.comment_created─► notifications (discussion.comment for B)   [R3]
B ─POST /links (Idempotency-Key)─► marketing (share links) ; friend F ─GET /l/:code─► 302 ?ref=code ─link.clicked─► links.events ─► click stats
F ─POST /checkout {ref} (Idempotency-Key)─► orders ──R1──► marketing LinkAttributionService.resolveAttributions ─► attribution frozen on the order
F ─pay (J01 chain)─► order.paid {…, attribution} (outbox, orders.events) ─►
        marketing affiliate-conversion consumer ─► conversion CONFIRMED ─link.converted─► links.events ; GET /links/:code/conversions, /stats
        discovery order-baskets consumer ─► basket ; job recommendations.build-bought-together ─► GET /products/:id/recommendations
        experimentation purchase consumer ─► purchase event ; GET /admin/experiments/:key/results
        (trending does not count purchases: S35)
storefront double ─POST /events {product_view, add_to_cart, exposure}─► analytics.events ─► discovery trending consumer ─► GET /trending
                                                                          └─► analytics store ─► experiment results
order.refunded ─► marketing affiliate-conversion consumer ─► conversion REVERSED (compensation)
```

In scope:

- The user-visible outcomes of the chain: the product in the feed, the post in a follower's feed, the comment notice, the click and the conversion on the link, the product in "bought together", in trending, and in an experiment's variant counts.
- The **eventual-consistency contract** of every asynchronous hop: maximum time to visibility on the local stack and how a client observes progress.
- The cross-domain failure modes: duplicate and out-of-order events, a consumer that is down and catches up, replay of a topic, the compensation path (a refunded order reverses its conversion; a deleted post leaves the feed; an archived product leaves the feed), retried requests with the same idempotency key.
- The **affiliate attribution contract** between checkout and share links, which no capability spec defines today (decided here as `[CONTRACT]`, see Cross-capability contracts).
- The hand-offs that are missing or broken in the code today (`gaps.md`).

Out of scope (owners named):

- Rules inside one domain: follow limits, celebrity fan-out, timeline windows and rebuild → **S26**; ranking, votes, nesting, markdown safety, shadow bans → **S25**; code generation, alias rules, destination safety, edge redirect → **S37**; co-occurrence thresholds math, hub normalisation, atomic list swap → **S34**; windows, watermark, Count-Min Sketch, top-K → **S35**; bucketing, layers, SRM, z-test maths → **S39**; checkout pricing, order state machine → **S10**; channel, preference and cap rules → **S28**.
- The buy chain from `POST /payments/intents` to `order.paid`, and everything after (ledger, payout, statements) → **J01**. J05 pays through the J01 chain and asserts only what the loop needs.
- Seller and product creation, plans, search indexing → **J02**, **J04**. J05 re-uses J02's `sellerFixture`.
- **Commission amounts and payout of affiliate earnings.** J05 proves that a conversion is recorded exactly once, reversed on refund, and announced; paying it is a later capability (S16's rates). See `questions.md`.
- Notification **delivery** → **S28**; this journey asserts the inbox item.
- Screens: no web capability owns the home feed, the follow button, the share panel or the experiments admin today (S26 `questions.md`). One UI scenario (AS-34) is specified as the only UI coverage S26 asks of J05; it stays **pending** until a web capability owns those pages.

## User Scenarios & Testing *(mandatory)*

### Notation and conventions

- People and things (created by the test through public APIs with unique names, so journeys can share a stack): shop `S` (verified, from J02's `sellerFixture`), owner `O`; buyers `B` (follows, discusses, shares), `W` (follows `B`), `F` (the friend who buys through the link), `C1`, `C2` (two more buyers), admin `A`. Products of `S`: companion `Q` (existing, price `1000`, stock `50`) and the new product `P` (price `2000`, stock `50`, category `audio`), created after `B` follows `S`. Order amounts are relational; one currency (`EUR`).
- Orders for the read models: `F` buys `{P, Q}` through the link (order `OF`); `C1` and `C2` buy `{P, Q}` without a link (`OC1`, `OC2`). Three paid orders by three different buyers are the minimum S34 trusts, so the journey never changes a threshold.
- Experiment `EX`: key `j05-<run id>-product-gallery`, `unit: "user"`, metric `purchase`, variants `control` and `treatment`, weights 5000/5000, layer unique to the run.
- No database, topic or queue is read by the test. A hand-off step is written **`[trigger] → [domain reacts] → [observable]`**. Triggers are an API call, a domain event, an SQS task or a scheduled job. Observables are public API reads, an SSE stream, the control surface or the event tap.
- **Waiting** is done only by polling an observable until it shows the expected state, with the deadline of the hop's contract (table below; deadline = 2 × maximum, poll interval 250 ms, scaled by `JOURNEY_TIME_FACTOR`). A fixed sleep is a test defect. Absence ("never") is asserted only after every consumer on the path reports `lag: 0` and the hop's maximum has elapsed on the stack clock.
- **Time is the stack clock** (J01's `GET|PUT /api/admin/clock`). Trending windows close by event time, so the journey advances the clock past the window end plus allowed lateness plus the idle timeout; no test waits for real minutes. The journey restores the clock and resumes every consumer in `afterAll`, even on failure.
- **Storefront double**: the web app emits no analytics events today (S35 gap). The test plays the storefront: it posts `product_view`, `add_to_cart` and `exposure` batches to `POST /api/events` with the buyer's token and an `X-Anonymous-Id` of 8–64 characters, a fresh `event_id` per event, exactly as W02/W03 must (S39 Requires). The affiliate cookie is played the same way: the test keeps the `ref` it read from the 302's `Location` and sends it in the checkout body.
- **Provider doubles** (local profile only): the payment provider of J01 (`pm_test_visa`), log doubles for e-mail/SMS/push; everything else is real.
- **Control surface** (J01's, admin role, local profile): `POST /api/admin/jobs` + `GET /api/admin/jobs/:jobId`; `GET /api/admin/consumers/:group`, `…/pause`, `…/resume`, `…/replay {since}`; `GET|PUT /api/admin/clock`. **J05 adds:** the job allow-list gains `recommendations.build-bought-together`; the J03 **event tap** `GET /api/admin/topics/:topic/messages?type=&key=&limit=` is used for `links.events` (`link.converted` exactly once) and `feed.events`.
- Every error is `application/problem+json` with a stable `code` (S54).

### Eventual-consistency contract (the hops)

Maximum time from the trigger until the result is visible **on the local stack** (single deployment of core, worker, projector, realtime; outbox relay interval ≤ 2 s). The owner of each hop must meet it; the journey tests wait on it.

| Hop | From → to | Visible through | Max | Owner |
|---|---|---|---|---|
| H1 | `POST /follow/:accountId` → follow state (synchronous) | `GET /follow-status`, `GET /me/following` | 0 s | S26 |
| H2 | `catalog.product_created` → `new_product` item in an active follower's timeline | `GET /feed` | 10 s | S26 (S05 emits) |
| H3 | `catalog.product_archived` / price drop → item hidden / `price_drop` item | `GET /feed` | 10 s | S26 |
| H4 | `discussion.post_created` → `post` item in the followers' feed | `GET /feed` of the author's follower | 10 s | S26, S25 |
| H5 | post deleted → gone from every feed (synchronous hydration) | `GET /feed` | 0 s | S25, S26 |
| H6 | `discussion.comment_created` → notice for the post's author | `GET /notifications`, `/unread-count`; SSE `user:<id>` | 5 s | S28 |
| H7 | `GET /l/:code` served → click in the owner's statistics | `GET /links/:code/stats` | 60 s | S37 |
| H8 | `POST /checkout {ref}` → attribution frozen on the order (synchronous) | `GET /orders/:id` (`attribution`) | 0 s | S10, S37 |
| H9 | `order.paid` → conversion `CONFIRMED` + `link.converted` | `GET /links/:code/conversions`, `/stats`; event tap | 10 s | S37 |
| H10 | `order.refunded` (full) → conversion `REVERSED` | `GET /links/:code/conversions` | 10 s | S37 |
| H11 | job `recommendations.build-bought-together` run → list replaced | `GET /products/:id/recommendations` | 30 s (build), 5 s to visible | S34 |
| H12 | `order.paid` → basket recorded (visible only through H11) | — | 10 s | S34 |
| H13 | events posted → trending, once the stack clock passed window end + lateness + idle | `GET /trending` | 35 s after the clock advance | S35 |
| H14 | `exposure` + `order.paid` → variant counts | `GET /admin/experiments/:key/results` | 60 s | S39 |
| H15 | a consumer resumed or replayed → `lag: 0` | `GET /api/admin/consumers/:group` | 15 s | S53 |
| H16 | any job run through the control surface → finished | `GET /api/admin/jobs/:jobId` | 5 s to start | S49 |

`order.paid` itself, payment and everything after are J01's hops H1–H11.

A consumer that is behind exposes its lag through `GET /api/admin/consumers/:group` (`lag`, `state`); a consumer at rest reports `lag: 0`.

Canonical consumer groups of this journey (group = name of the projector; today's names differ, see `gaps.md`): `community-feed-products` (S26; `products.events`), `community-feed-discussions` (S26; `discussion.events`), `community-feed-fanout` (S26; `feed.events`), `notification-router` (S28), `marketing-link-clicks` (S37; `links.events`), `marketing-affiliate-conversions` (S37; `orders.events`: `order.paid`, `order.refunded`), `discovery-order-baskets` (S34), `discovery-trending-topk` (S35; `analytics.events`), `experimentation-purchases` (S39; `orders.events`: `order.paid`), `search-product-index` (J02/J04).

---

### User Story 1 — A follower sees the shop's new product in their feed, and only while it is sellable (Priority: P1)

A buyer follows a shop. When the shop lists a product, the buyer finds it in their home feed within seconds, once. If the product is archived, it disappears. Nothing the shop does while the feed consumer is down is lost.

**Why this priority**: it is the first half of the loop and the only way the buyer learns about the product; the hand-off crosses catalog, the feed's product copy, fan-out and the read API.

**Independent Test**: `B` follows `S`, `B` reads the feed once (active), `O` creates `P`, poll `GET /feed`.

**Acceptance Scenarios**:

1. **AS-01** (follow, then the new product appears) — **Given** `S` with `Q` and buyers `B` (signed in) and `X` (does not follow), **When** (1) `B` calls `POST /follow/shop:S` → *community* → `204`; (2) `B` calls `GET /follow-status?accountIds=shop:S` → `[{accountId: "shop:S", following: true, followerCount: 1}]` (H1) and `GET /me/following` lists `shop:S`; (3) `B` calls `GET /feed` → `200 {items: [], nextCursor: null}` (this marks `B` active); (4) `O` creates `P` through the catalog API → *catalog appends `catalog.product_created` in the product's transaction; the feed's product projector copies the fields; the item is stored once and announced `feed.item_published`; the fan-out consumer pushes it into `B`'s timeline* → **Then** within H2 `GET /feed` as `B` returns exactly one item `{kind: "new_product", author: {accountId: "shop:S", type: "shop", name: <S's name>}, title: <P's title>, payload: {productId: P, priceMinor: 2000, currency: "EUR"}}`; `X`'s feed has none; the event tap of `feed.events` lists exactly one `feed.item_published` for the item.
2. **AS-02** (a follower who has not read yet, and one who follows later) — **Given** AS-01, **When** `C1` follows `S` only after `P` exists and then reads `GET /feed` for the first time, **Then** the item is in the first page (following makes recent items visible on the next read) and appears once.
3. **AS-03** (duplicate and replayed events change nothing) — **Given** AS-01, **When** the operator replays `products.events` from the journey start for group `community-feed-products` and `feed.events` for `community-feed-fanout` through the control surface, **Then** after `lag: 0` `B`'s feed still holds the item exactly once, the event tap still shows one `feed.item_published` for it, and `GET /follow-status` is unchanged.
4. **AS-04** (a product that is no longer sellable leaves the feed; an old event cannot bring it back — out of order) — **Given** AS-01, **When** `O` archives `P` (`catalog.product_archived`, version newer than created) → *the feed's product copy takes the newer version* (H3), **Then** `B`'s `GET /feed` no longer contains the item; **When** the operator replays `products.events` from the start (the older `product_created` arrives after the newer `product_archived`), **Then** the item stays hidden and no new item is created; **When** `O` restores `P`, **Then** within H3 the original item is visible again once.
5. **AS-05** (feed consumer down, then catch-up; the seller never waits) — **Given** group `community-feed-fanout` paused and a second new product `P2` created by `O`, **When** `B` polls `GET /feed` for H2 + 2 s, **Then** `P2` is absent while `GET /api/admin/consumers/community-feed-fanout` shows `lag ≥ 1`, and `O`'s create answered `201` at once; **When** resumed, **Then** within H15 + H2 `B`'s feed holds `P2` exactly once, newest first.
6. **AS-06** (an event nobody should turn into an item) — **Given** `O` creates a sandbox product `PS` and a product that starts as a draft `PD` (not ACTIVE), **When** H2 has elapsed and `community-feed-products` reports `lag: 0`, **Then** `B`'s feed has no item for either; **When** `O` lowers `P`'s price from `2000` to `1500`, **Then** within H3 one `price_drop {productId: P, previousPriceMinor: 2000, priceMinor: 1500}` item exists; a second drop within 24 h of the stack clock creates none.

---

### User Story 2 — A buyer starts a discussion about the product; followers see the post, the seller's answer reaches the buyer, a deleted post vanishes (Priority: P1)

**Why this priority**: it carries identity, catalog (the board is a product), the feed and notifications in one flow, and a deleted post must never linger in someone's feed.

**Independent Test**: `W` follows `B`; `B` posts on `P`'s board; `O` answers; read `W`'s feed and `B`'s inbox.

**Acceptance Scenarios**:

1. **AS-07** (post → followers' feed) — **Given** `W` follows `user:B` and has read the feed once, **When** (1) `B` calls `POST /boards/P/posts {title, body}` with `Idempotency-Key: k-j05-0001` → *community; the board is validated against the product through catalog (R1)* → `201 PostView`; (2) *`discussion.post_created` is recorded with the write and relayed on `discussion.events`; the feed's discussion projector stores a `post` item* (H4) → **Then** `W`'s `GET /feed` holds one item `{kind: "post", author: {accountId: "user:B", type: "user"}, title, payload: {postId, boardId: P}}`; a buyer who does not follow `B` sees no such item; `GET /boards/P/posts?sort=new` (anonymous) lists the post first.
2. **AS-08** (retried post, same key, and ten at once) — **Given** AS-07, **When** `B` repeats the create five times at once with the same key, then once more, **Then** every answer is `2xx` with the same `postId`, the board lists one post, `W`'s feed holds one `post` item after H4, and the same key with another body answers `422 idempotency_key_reuse`; a missing key `422 idempotency_key_required`.
3. **AS-09** (the seller's answer notifies the author) — **Given** AS-07, **When** `O` calls `POST /posts/:postId/comments {body}` with a key → *community records `discussion.comment_created`* → *notifications routes it to `postAuthorId`* (H6), **Then** `B`'s `GET /notifications` holds exactly one item `{type: "discussion.comment", category: "discussions", read: false}` whose text mentions the preview, `unread-count` is `{unread: 1}`, SSE `user:<B>` carried one `notification`; `O` (the commenter) has no such item; `W` has none.
4. **AS-10** (a deleted post leaves every feed at once, and the late event is harmless — compensation) — **Given** AS-09, **When** `B` calls `DELETE /posts/:postId` → *community; feed hydration asks the discussion query service (R1)* (H5), **Then** the next `GET /feed` of `W` omits the post item immediately (no polling), `GET /posts/:postId` answers `404`, and after H4 the event tap shows one `discussion.post_deleted`; **When** the operator replays `discussion.events` from the start (the old `post_created` after `post_deleted`), **Then** `W`'s feed still omits it and no item is created.
5. **AS-11** (discussion consumer down, then catch-up) — **Given** group `community-feed-discussions` paused, **When** `B` posts again, **Then** the post exists at once (`GET /posts/:id`) and `W`'s feed lacks the item with `lag ≥ 1`; **When** resumed, **Then** within H15 + H4 the item exists exactly once.
6. **AS-12** (a board exists only for a product) — **Given** an unknown product id, **When** `B` posts to `/boards/<unknown uuid>/posts`, **Then** `404 board_not_found`, no event on `discussion.events` (event tap), and `W`'s feed is unchanged.

---

### User Story 3 — A friend buys through the buyer's short link and the buyer is credited once (Priority: P1)

**Why this priority**: it is the only place where share links, checkout and payment meet, and it is the money-adjacent hand-off of the loop; it has no owner in any spec today.

**Independent Test**: create a link, follow it, check out with `ref`, pay, read the link's conversions.

**Acceptance Scenarios**:

1. **AS-13** (link → click → attributed order → paid → conversion) — **Given** `B` and `F` signed in (`F` is not `B`), **When** (1) `B` calls `POST /links {destination: <P's page>}` with `Idempotency-Key: k-j05-0010` → *marketing* → `201 {code, shortUrl, …}`; (2) `F` (anonymous) calls `GET /l/<code>` → *marketing; one `link.clicked` on `links.events`* → `302` with `Location` carrying `ref=<code>` (the test keeps the `ref`); (3) after H7 `B`'s `GET /links/<code>/stats` shows `total: 1`; (4) `F` adds `P` and `Q` to the cart and calls `POST /checkout {ref: <code>}` with `Idempotency-Key: k-j05-0011` → *orders; the reference is resolved through marketing's attribution lookup (R1) and a copy is frozen on the order* → `202 {orderId: OF, status: "RESERVED", …}`; (5) `GET /orders/OF` shows `attribution: {code}` (H8) and no owner id; (6) `F` pays through the J01 chain → *orders appends `order.paid` with `attribution: {code, ownerId: B}` in the paid transaction* → *marketing's conversion consumer records a conversion and announces `link.converted`* (H9); **Then** `B`'s `GET /links/<code>/conversions` lists exactly one `{conversionId, paidAt, amountMinor: <OF's total>, currency: "EUR", status: "CONFIRMED", refundedMinor: 0}` with no buyer identity, `GET /links/<code>/stats` shows `conversions: 1` and `convertedMinor: <OF's total>`, and the event tap of `links.events` lists exactly one `link.converted {conversionId, code, ownerId: B, orderId: OF, amountMinor, currency, occurredAt}`; a third user cannot read these (`404 link_not_found`).
2. **AS-14** (retried checkout, same key, five at once) — **Given** a second cart of `F`, **When** `POST /checkout {ref}` is sent five times at once with the same key, then once more after the answers, **Then** every answer is `2xx` with the same `orderId`, one order exists, its attribution is that of the first request, and after payment exactly one conversion exists for it (H9); the same key with a different `ref` answers `422 idempotency_key_reuse`.
3. **AS-15** (duplicate and out-of-order `order.paid`; consumer down; catch-up) — **Given** group `marketing-affiliate-conversions` paused, **When** `F` pays another attributed order, **Then** the order is `PAID` at once and `B`'s conversions list is unchanged with `lag ≥ 1`; **When** resumed, **Then** within H15 + H9 exactly one more conversion exists; **When** the operator replays `orders.events` from the journey start for the group, **Then** the conversion list, `stats` and the count of `link.converted` on the tap are unchanged (one per order).
4. **AS-16** (self-referral is not credited) — **Given** `B` has a link `LB`, **When** `B` checks out with `ref: LB` and pays, **Then** the order is accepted (`202`, `attribution: null`), and after H9 + `lag: 0` `B`'s conversions list is unchanged and no `link.converted` exists for the order.
5. **AS-17** (an unknown, malformed or disabled reference never blocks a purchase and is never credited) — **Given** a disabled link `LD` (owner disables it after the click) and the strings `zzzzzzz` and `not a code!`, **When** `F` checks out with each as `ref`, **Then** each answer is `202`, `attribution: null`, the orders can be paid, and no conversion exists for any; an expired link still credits (the click happened while it was active): with the clock advanced past its expiry, a checkout with `ref` of an `EXPIRED` link carries `attribution: {code}` and a conversion follows.
6. **AS-18** (a clicked link does not credit by itself; a buyer without `ref` is not attributed) — **Given** `C1` clicks `LB` but checks out without `ref`, **When** `C1`'s order is paid, **Then** `attribution: null` and no conversion; `B`'s `stats` show the click (`total` +1) and no new conversion.
7. **AS-19** (a refund reverses the credit — compensation) — **Given** AS-13, **When** a full refund of `OF` is requested (through J01's refund path) → *payments refunds, orders appends `order.refunded {amountMinor = total}`* → *marketing's conversion consumer marks the conversion* (H10), **Then** `B`'s conversion for `OF` shows `status: "REVERSED"`, `refundedMinor = amountMinor`, `stats.conversions` and `convertedMinor` no longer count it, and the tap shows one `link.converted` and one `link.conversion_reversed {conversionId, code, ownerId, orderId, refundedMinor}`; a partial refund keeps `CONFIRMED` with `refundedMinor` set and `convertedMinor` reduced by it; the same `order.refunded` delivered twice, or arriving **before** its `order.paid` (replay in reverse), ends in the same state.
8. **AS-20** (a failed or cancelled order never credits) — **Given** an attributed order that is declined (`pm_test_declined`) or whose reservation expires, **When** H9 has elapsed, **Then** the order is `CANCELLED`, there is no conversion and no `link.converted` for it.
9. **AS-21** (the share link is created once per key) — **Given** AS-13 step (1), **When** the same create is sent five times at once, **Then** one link (`GET /links` lists one for that destination), the same `code` in every answer; a destination outside the marketplace answers `422 destination_not_allowed` and creates nothing.

---

### User Story 4 — The purchase makes the product show up in "bought together" (Priority: P2)

**Why this priority**: it proves the read model is built from the paid-order stream, not from a shared table, and shows the thresholds are honoured by the loop.

**Independent Test**: three paid orders of three buyers with `{P, Q}`, run the build, read the rail.

**Acceptance Scenarios**:

1. **AS-22** (three buyers, one build, the rail appears) — **Given** `OF` (AS-13) and the paid orders `OC1` (`C1`) and `OC2` (`C2`), each `{P, Q}`, **And** `GET /products/P/recommendations` returns `items: []`, **When** (1) the baskets are recorded (H12) → *discovery's basket consumer*; (2) the operator runs `POST /api/admin/jobs {type: "recommendations.build-bought-together", idempotencyKey}` → *discovery builds and swaps the lists* (H11 / H16), **Then** `GET /products/P/recommendations` (anonymous) returns `Q` with `hops: 1` and `score` in `(0, 1]`, and `GET /products/Q/recommendations` returns `P`; money is `priceMinor`/`currency`; an archived or out-of-stock `Q` is not returned (visibility is checked at read).
2. **AS-23** (fewer than the trust threshold shows nothing) — **Given** a fresh pair `{P, R}` bought by one buyer, **When** the build runs, **Then** `P`'s list contains no `R`.
3. **AS-24** (duplicate and re-ordered `order.paid`; consumer down) — **Given** `discovery-order-baskets` paused and a fourth order `OC3` paid, **When** the build runs, **Then** it does not include `OC3` (lists unchanged, the rail still correct); **When** resumed and `lag: 0`, and the same `order.paid` is replayed from the journey start, and the build runs again, **Then** the result is identical to a run in which each order was delivered once (basket per order, not per delivery).
4. **AS-25** (a refund does not retract the rail) — **Given** AS-19, **When** the build runs again, **Then** `Q` is still recommended with `P` (S34: the purchase intent was real).

---

### User Story 5 — The shopper's engagement shows up in trending, and a purchase on its own does not (Priority: P2)

**Why this priority**: it pins the contract between the analytics stream and trending that no other spec proves, and makes the S35 decision visible instead of surprising.

**Independent Test**: post views and add-to-carts for `P` from several visitors, advance the clock, read `GET /trending`.

**Acceptance Scenarios**:

1. **AS-26** (events → ranking) — **Given** `P` (category `audio`) and `Q` visible, **When** (1) the storefront double posts `product_view` for `P` from 8 distinct visitors and `add_to_cart` for `P` from 4 of them (`props.product_id`, `props.category: "audio"`), and `product_view` for `Q` from 2 → `POST /events` → `202 {accepted, rejected: []}`; (2) *analytics ingestion publishes to `analytics.events`; discovery's trending consumer counts them in the minute window*; (3) the clock is advanced past the window end + lateness + idle → *windows merge* (H13), **Then** `GET /trending?category=audio` lists `P` above `Q` with `score` equal to the weighted sum (views 1, add-to-carts 5 → `8 + 20 = 28` for `P`, `2` for `Q`), only visible products, `windowMinutes: 60`.
2. **AS-27** (a paid order alone does not move trending) — **Given** AS-26's scores, **When** `F`, `C1`, `C2` pay `{P, Q}` orders (AS-13, AS-22) and H13 plus `lag: 0` have elapsed, **Then** `P`'s `score` is unchanged.
3. **AS-28** (duplicate delivery and a bad event; consumer down) — **Given** AS-26, **When** the same batch (same `event_id`s) is posted again, **Then** `202` and scores unchanged after H13; a batch with one event whose `product_id` is not a UUID answers `202 {accepted: n-1, rejected: [{index, code}]}` and the rest count; **When** group `discovery-trending-topk` is paused for one batch of 3 more `add_to_cart` events and resumed, **Then** after H15 + H13 `P`'s score rises by exactly `15`.
4. **AS-29** (a product that is no longer sellable leaves the ranking) — **Given** AS-26, **When** `O` archives `P`, **Then** `GET /trending?category=audio` omits `P` (visibility is checked against catalog at read time) within H3.

---

### User Story 6 — The purchase shows up in the A/B experiment results exactly once (Priority: P2)

**Why this priority**: it joins three streams (exposure from the client, purchase from the order, assignment from the experiment definition) and is the one place where event order changes the answer.

**Independent Test**: start a `user`-unit experiment on `purchase`, expose buyers, pay, read results.

**Acceptance Scenarios**:

1. **AS-30** (exposure then purchase → conversion) — **Given** `EX` created by `A` (`PUT /admin/experiments/:key`, `POST …/start`), **When** (1) `F` calls `GET /experiments/assignments` with their token → `{assignments: {EX: {variant}}, degraded: false}`, the same variant on every call; (2) the storefront double posts one `exposure {experiment: EX, variant}` for `F`; (3) `F`'s order `OF` is paid → *experimentation derives a `purchase` event with `user_id = F`*, **Then** within H14 `GET /admin/experiments/EX/results` (admin) counts `F` as exposed in their variant and as one conversion in that variant; the other variant is unchanged; a non-admin gets `403`, no credentials `401`.
2. **AS-31** (a purchase before the exposure does not count — out of order) — **Given** `C1`'s order `OC1` is paid **before** `C1` is exposed, **When** `C1`'s exposure is posted afterwards, **Then** the results count `C1` as exposed and **not** converted; **When** `C1` pays a further order after the exposure, **Then** `C1` converts once (a unit converts at most once however many orders).
3. **AS-32** (duplicate delivery and replay change no number) — **Given** AS-30, **When** the same exposure batch (same `event_id`) is posted again, and `orders.events` is replayed for group `experimentation-purchases` from the journey start, **Then** after `lag: 0` and H14 `exposures` and `conversions` per variant are identical; with the consumer paused during a payment the results lag but, once resumed, count it once.
4. **AS-33** (a different identity does not join — no stitching) — **Given** an exposure posted by a visitor with no token (`X-Anonymous-Id` only) and later the same person signs in and pays, **When** results are read, **Then** the purchase does not convert in the `user`-unit experiment, and the anonymous exposure is not counted in it (a `user` experiment counts signed-in exposures only); the result carries `excluded.unattributable` greater than 0.

---

### User Story 7 — The whole loop survives replay, restarts and has one front door (Priority: P3)

**Acceptance Scenarios**:

1. **AS-34** (UI happy path — **pending** until a web capability owns the pages) — **Given** a signed-in `B` and a shop `S` with a new product, **When** `B` presses Follow on the shop page, `O` publishes `P`, and `B` opens the home feed, **Then** the feed card shows the product title and price and links to it (Playwright `packages/web/tests/engagement-loop.spec.ts`, web-first assertions, no fixed sleeps, isolated users). It is the only UI scenario; edge cases stay at the API layer.
2. **AS-35** (the whole loop replayed from the beginning) — **Given** AS-01 to AS-33 completed and every observable recorded (feed pages of `B` and `W`, `B`'s inbox and unread count, link stats and conversions, the rails of `P` and `Q`, trending, experiment results), **When** the operator replays every topic of the loop from the journey start for every group listed in the notation (feed, notifications, links, baskets, trending, purchases), runs the build job again and reaches `lag: 0` on all groups, **Then** every recorded observable is unchanged except `asOf` timestamps.
3. **AS-36** (privacy of the loop) — **Given** the run, **When** responses, events on the tap and the application's logs are inspected, **Then** no conversion, link statistics, event or log line exposes the buyer's identity to the link owner (no `userId`, e-mail or address of `F` in `conversions`, `stats`, `link.converted`), the `ref` is a share code and carries no user data, analytics logs carry no `props` values, and the idempotency keys never appear in events.
4. **AS-37** (static gates) — **Given** the code, **When** the gates run, **Then** `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry` pass, and no domain of the loop injects another domain's model or queries its tables (the feed no longer reads `Product`; orders no longer injects `ProductModel` in a controller; discovery reads catalog through `ProductQueryService.getProductsByIds`).

---

### Edge Cases

- A follower of a **celebrity** shop is served by read-time merge, not fan-out: the item still appears within H2 (rule proven by S26; J05 uses a normal shop and does not re-test it).
- A `ref` in the checkout body that is not a string of 3–64 URL-safe characters answers `400 validation_failed` (shape), but an **unknown well-formed** code is accepted and ignored (AS-17).
- The same order can carry only one attribution; a second `POST /checkout` with another `ref` and another key is another order.
- An attributed order paid with a **different currency** than the link owner's is still recorded in the order's currency; the journey uses one currency.
- Orders cancelled after `PAID` do not exist; reversal happens only through `order.refunded`.
- The link owner is **deleted or unknown** when the conversion arrives: the conversion is still recorded (the code is the key); a notice is not produced.
- A product on a board is archived after the post was written: the post stays readable; new posts answer `409 board_closed` (S25).
- If the analytics stream is down, the storefront double's batch answers `503` or `202 accepted: 0`; trending and experiments do not change; purchases still reach experiments through the order stream (AS-30 does not depend on ingestion health).

## Requirements *(mandatory)*

### Functional Requirements

**The loop**

- **FR-001**: Following a shop MUST be readable at once from both sides, and a product created afterwards MUST reach an active follower's feed exactly once within H2, through the product's event only (AS-01, AS-02).
- **FR-002**: The feed MUST hide a product that is not sellable and MUST NOT re-show it because an older event is replayed (AS-04, AS-06).
- **FR-003**: A post MUST reach its author's followers' feeds within H4 through its event only, and MUST leave every feed at once when deleted (AS-07, AS-10).
- **FR-004**: A comment MUST notify the post's author (not the commenter) once, within H6 (AS-09).
- **FR-005**: A checkout MAY carry a share reference `ref`; the reference MUST be resolved through marketing's exported lookup (R1) and a copy of `{code, ownerId}` MUST be frozen on the order at checkout, visible to the buyer without the owner id (AS-13, AS-16, AS-17).
- **FR-006**: An unknown (well-formed), disabled or self-owned reference MUST NOT fail or change the checkout; the order carries `attribution: null`. An `EXPIRED` link MUST still attribute (AS-16, AS-17).
- **FR-007**: `order.paid` MUST carry `paidAt` and `attribution: {code, ownerId} | null` and be appended in the paid transition's transaction (AS-13).
- **FR-008**: Each attributed paid order MUST yield exactly one conversion for the link's owner, recorded from `order.paid` only, announced once as `link.converted`, and readable by the owner without buyer identity (AS-13, AS-14, AS-15, AS-36).
- **FR-009**: A refund MUST reverse the conversion proportionally (`refundedMinor`), exactly once and in any order of arrival relative to `order.paid`; a failed or cancelled order MUST never create one (AS-19, AS-20).
- **FR-010**: Every paid order MUST become one basket for recommendations and, when a signed-in exposure to a running `user` experiment precedes it, one conversion for the experiment; trending MUST NOT count purchases (AS-22, AS-27, AS-30).
- **FR-011**: A purchase paid before the buyer's first exposure MUST NOT convert in the experiment; a unit converts at most once (AS-31).
- **FR-012**: The recommendations rail MUST show a pair only when at least 3 orders by 3 buyers support it, after the build job; the journey MUST NOT lower any threshold (AS-22, AS-23).
- **FR-013**: Trending MUST rank by event-time windows closed by the stack clock; duplicate event ids and invalid events MUST NOT change scores (AS-26, AS-28).

**Failure modes**

- **FR-020**: Every consumer of the chain MUST be idempotent (inbox, unique key on `eventId`, or version-guarded upsert), validate its payload, and dead-letter poison messages without blocking (IV.5). Their module documents the mechanism (AS-03, AS-15, AS-24, AS-28, AS-32).
- **FR-021**: Events of one aggregate MUST be keyed by the aggregate id; consumers MUST discard an event older than the state applied (`productVersion`, `orderVersion`) (AS-04, AS-10, AS-19).
- **FR-022**: A consumer that is down MUST lose nothing: after resuming every fact is applied once and the lag is visible (AS-05, AS-11, AS-15, AS-24, AS-28, AS-32).
- **FR-023**: Every request that creates something (`POST /boards/…/posts`, comments, `POST /links`, `POST /checkout`) MUST be safe to retry with its `Idempotency-Key` (AS-08, AS-14, AS-21).
- **FR-024**: A hand-off from a state change MUST be published through the outbox (or the owner's own durable store plus relay where the domain owns no Postgres table), never as a direct, unrecorded send after the write (IV.4): `catalog.product_created`, `discussion.*`, `feed.item_published`, `order.*` (AS-01, AS-07).
- **FR-025**: Cross-domain data MUST flow only by R1 (feed post hydration, board validation, attribution lookup, product visibility reads), R3 (events into the owner's read model) or R2 (UI composition); no domain of the chain reads another's tables (AS-37).

**Observability and control (journey support)**

- **FR-030**: Every hop in the contract table MUST meet its maximum time on the local stack and be observable through the API named in the table (all scenarios).
- **FR-031**: All domains of the loop MUST take time only from the injected platform clock, so advancing the stack clock closes trending windows and makes the experiment window, link expiry and 24-hour price-drop rule behave (AS-06, AS-17, AS-26).
- **FR-032**: The control surface of J01–J03 MUST additionally allow the job `recommendations.build-bought-together` and expose the canonical consumer groups of this journey with `lag`; each is refused at startup in production (all scenarios).
- **FR-033**: The journey MUST drive and observe only through public APIs, SSE, the control surface and the event tap, and MUST resume paused consumers and reset the clock even when it fails (all scenarios).

**Safety**

- **FR-034**: A user MUST see only their own links' conversions, notices and attribution; the link owner MUST never learn who bought; admin-only experiment results (AS-13, AS-30, AS-36).
- **FR-035**: Events, logs and error bodies MUST NOT carry idempotency keys, buyer identities in link/conversion data, or analytics `props` values (AS-36).

### Key Entities

- **Follow / feed item / timeline**: a buyer's relation to a shop or user, a stored thing that happened, and the buyer's newest-first list of items.
- **Post / comment**: a discussion entry on a product's board and an answer to it.
- **Short link / click / reference (`ref`)**: the owner's link, one served redirect, and the code a buyer carries to checkout.
- **Attribution / conversion**: the frozen copy of `{code, ownerId}` on an order, and the owner's credit for one paid order (`CONFIRMED` or `REVERSED`, with the refunded part).
- **Basket / rail**: the distinct products of a paid order, and the list of products bought together.
- **Window / ranking**: one minute of weighted interactions and the top products of the last hour.
- **Experiment / exposure / purchase event / result**: the definition of an A/B test on a user unit, the first time a user saw a variant, the order-derived conversion event, and the per-variant counts.
- **Consumer group**: a named subscription with state and lag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A product a shop publishes is in an active follower's feed within 10 seconds in 99% of runs, exactly once in 100% of runs, including after replay and after the feed consumer was down.
- **SC-002**: A deleted post or an archived product is absent from the next feed read in 100% of runs (0 leaks), including after the topic is replayed.
- **SC-003**: The author of a post gets exactly one notice per answer within 5 seconds in 99% of runs.
- **SC-004**: Every paid order made through a share link credits the link owner exactly once within 10 seconds in 99% of runs; 0 duplicate and 0 missing credits under retries, replays and a consumer outage; 0 credits for self-referrals, failed orders or disabled links; a full refund reverses the credit within 10 seconds in 99% of runs.
- **SC-005**: A checkout with an unknown, disabled or self-owned reference completes normally in 100% of runs (0 failed purchases because of a reference).
- **SC-006**: After three paid orders by three buyers and one build run, the product appears in its partner's "bought together" rail within 5 seconds of the build finishing; with fewer buyers it appears in 0% of runs.
- **SC-007**: Product interactions are reflected in trending within 35 seconds of the stack clock passing the window; replaying the same events changes 0 scores; purchases change 0 scores.
- **SC-008**: Experiment results count a purchase after an exposure within 60 seconds, once per user; 0 conversions for a purchase made before the exposure; replays change 0 numbers.
- **SC-009**: With any one consumer of the journey paused during its step and resumed afterwards, 0 facts are lost and 0 applied twice; lag returns to 0 within 15 seconds of resuming.
- **SC-010**: The journey runs from a clean local stack to green in under 12 minutes with 0 fixed sleeps and 0 real-time waits longer than the hop deadlines.

## Assumptions

- Every default below is also a line in `questions.md`; those that change an existing contract are tagged `[BREAKING]` there.
- **Decision policy**: where the codebase and the notes disagree, the production-grade option wins (events through the outbox, R1/R3 only, version-guarded idempotent consumers, idempotency keys on every creating call, the injected clock), because there are no external clients to keep compatible.
- **The affiliate contract is defined here.** Checkout takes the share code as an optional body field `ref` (explicit, sent by the storefront from its first-party cookie), not as an ambient cookie. Orders resolve it once at checkout through `LinkAttributionService.resolveAttributions` (R1), freeze `{code, ownerId}` on the order, and put it into `order.paid`. Marketing owns the conversion record and consumes `order.paid` / `order.refunded`.
- **Attribution rule**: `ACTIVE` and `EXPIRED` codes attribute; `DISABLED`, unknown and self-owned codes do not; the checkout never fails because of `ref`; last `ref` sent with the checkout wins (one per order).
- **Conversion = a paid, attributed order.** It is created from `order.paid` only (never at checkout, never at click). A refund reduces it proportionally; a full refund marks it `REVERSED`. No commission amount or payout is computed here; `link.converted` and `link.conversion_reversed` are the interface a later commission capability (S16) consumes.
- **The link owner sees amounts but never the buyer.** Conversion rows hold `conversionId`, `paidAt`, `amountMinor`, `currency`, `status`, `refundedMinor`; the internal order id stays inside marketing and the event.
- **Trending does not count purchases** (S35 decision, honoured): the journey drives `product_view` and `add_to_cart` through the ingestion API as the storefront would, and asserts that a paid order alone changes nothing. A server-side purchase signal is a separate S35 decision (`questions.md`).
- **"The purchase shows up in recommendations"** means: after the build job, honouring S34's 3 orders / 3 buyers threshold. The nightly schedule is not waited for; the job is run through the control surface.
- **A/B uses a `user`-unit experiment on `purchase`** (S39 questions). Signed-in exposure is required; no stitching of an anonymous visitor into a user.
- **Discussion posts are authored by `user:<id>`** and appear in the feed of the author's followers; a buyer's own shop-follow feed is what AS-01 reads. Buyers have no display name.
- **No notification for `new_product`**: S28 notifies followers only for `drop_announced` and `auction_started`; the feed is the observable.
- **Local stack timing**: numbers in the hop table assume one deployment of core, worker, projector and realtime, outbox relay ≤ 2 s, read caches no longer than the capability specs state (trending 30 s, rail 60 s at the CDN only, not in the API). A journey owns the stack clock while it runs; journeys run serially.
- **Names**: shop `S`, buyers and products are created per run with unique names, so journeys can share a stack. One currency (`EUR`).

## Cross-capability contracts

Searched before writing: `grep -rl` over `specs/domains specs/web specs/journeys` for `J05` and `journeys`. Contracts the earlier specs require from this journey, and how they are honoured:

- **S26** (spec, `test-plan.md`, `gaps.md`): "J05 covers follow → feed at the UI level"; uses `GET /follow-status`, `GET /feed`, `POST /follow/:accountId`. Honoured: AS-01 to AS-06, AS-34 (UI, pending a web owner). S26's rows AS-01 and AS-13 name J05 as the cross-domain proof.
- **S25** (spec): R1 `DiscussionQueryService.getPostsByIds` "Consumer: S26, **J05**" (deleted posts vanish). Honoured indirectly and black box: AS-10 asserts the effect; J05 does not call the export.
- **S37** (spec, questions): "SD-08 and J05 expect checkout reads `ref` → commission entry"; `LinkAttributionService.resolveAttributions(codes)` for S10 / the commission consumer (J05). **Honoured and extended** (as `[CONTRACT]`): checkout calls the lookup; S37 additionally owns the conversion consumer, `GET /links/:code/conversions`, the `conversions`/`convertedMinor` stats and the events `link.converted` / `link.conversion_reversed`. S37's spec states that no spec asks for these; J05 asks.
- **S39** (spec, questions): "J05 creates a `unit: "user"`, metric `purchase` experiment and polls results for up to 60 s after the purchase (FR-044)". Honoured: AS-30 to AS-33, H14 = 60 s.
- **S35, S34, S10, S28**: S34/S35 consume `order.paid` and `analytics.events` as specified; S10 and S28 name no J05 contract. **Differs**: S10's checkout body is `{expectedTotalMinor?}` with unknown properties rejected (adds `ref`), and `order.paid` has no `paidAt` or `attribution` (S34's Requires already assume `paidAt`); S28 maps no notice for `new_product` (kept).
- **J01**: the buy chain and the control surface; **J02**: `sellerFixture`; **J03**: the event tap and the queue/consumer extensions. Honoured as stated in the notation.

**Provides** (J05 has no runtime exports; it provides a test, fixtures and a timing contract):

- `packages/backend/test/journeys/engagement-loop.journey-spec.ts` (top-level `describe` "Journey J05: engagement loop", one nested `describe` per user story) and `packages/web/tests/engagement-loop.spec.ts` (AS-34, pending).
- `packages/backend/test/journeys/support/` additions to the kit of J01–J03: `engagementFixture` (follow, publish product, post, link, referred checkout, paid order, experiment helpers over the public routes), `storefrontDouble` (batched `POST /events` with `event_id`, `X-Anonymous-Id`, token), and `waitForContract(hop, probe)` rows H1–H16.
- **The hop table** (H1–H16) and **the canonical consumer-group names** under "Eventual-consistency contract".

**Requires** (owner and exact shape assumed). Items marked **new** are asked of the owner by this journey:

- **S26 (community feed)**: `POST|DELETE /follow/:accountId` (`204`), `GET /follow-status?accountIds=` → `{accountId, following, followerCount}[]`, `GET /me/following`, `GET /feed?limit&cursor` → `{items: FeedItemView[], nextCursor}`; event `feed.item_published` v1 `{itemId, authorId, kind, createdAt}` on `feed.events` keyed `authorId`; consumer groups **`community-feed-products`**, **`community-feed-discussions`**, **`community-feed-fanout`** (idempotent, version-guarded, zod, DLQ); the feed reads posts via S25 R1 and shops via S03 R1 and no longer reads `Product`.
- **S25 (community discussions)**: `POST /boards/:productId/posts` (`Idempotency-Key`), `GET /boards/:productId/posts`, `GET /posts/:postId`, `DELETE /posts/:postId`, `POST /posts/:postId/comments`; events on `discussion.events` keyed `postId`: `discussion.post_created`, `post_deleted`, `comment_created {commentId, postId, boardId, authorId, parentCommentId, parentAuthorId, postAuthorId, preview, createdAt}`; recorded with the write (own store + relay); no in-process publish into the feed.
- **S05 (catalog)**: typed events on `products.events` keyed `productId`: `catalog.product_created|updated|archived|restored|deleted` with `productVersion`, `changedFields`, `status`, `isSandbox`, in the product's transaction (**new for the code**: today a legacy `{productId}` row only); `ProductQueryService.getProductsByIds`.
- **S37 (marketing)**: `POST /links`, `GET /links`, `GET /l/:code`, `GET /links/:code/stats` (**new fields** `conversions`, `convertedMinor`), **new** `GET /links/:code/conversions?limit&cursor` → `{items: [{conversionId, paidAt, amountMinor, currency, status: "CONFIRMED" | "REVERSED", refundedMinor}], nextCursor}` (owner only, `404 link_not_found` for others); R1 `LinkAttributionService.resolveAttributions(codes)` → `Record<code, {code, ownerId, status}>`; events on `links.events` keyed by `code`: `link.clicked`, **new** `link.converted` v1 `{conversionId, code, ownerId, orderId, amountMinor, currency, occurredAt}` and `link.conversion_reversed` v1 `{conversionId, code, ownerId, orderId, refundedMinor}` (at least once, deduplicated by `conversionId`); consumer groups **`marketing-link-clicks`** and **new `marketing-affiliate-conversions`** on `orders.events` (`order.paid`, `order.refunded`; idempotent on `orderId` with `orderVersion` guard, zod, DLQ).
- **S10 (orders)**: `POST /checkout` with **new optional `ref`** (3–64 chars `[A-Za-z0-9_-]`; `Idempotency-Key`), `GET /orders/:id` (**new** `attribution: {code} | null`); `order.paid` v1 `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines, shopOrders, attribution: {code, ownerId} | null, orderVersion}` and `order.refunded {orderId, userId, amountMinor, currency, reason, orderVersion}` through the outbox on `orders.events`; the R1 call to marketing's lookup is made once at checkout and never from a controller with an injected foreign model.
- **S34 (discovery)**: `order.paid` consumer group **`discovery-order-baskets`** (version-guarded upsert by `orderId`); job `recommendations.build-bought-together {days?, buckets?}`; `GET /products/:productId/recommendations` → `{type, items: [{productId, title, priceMinor, currency, score, hops}]}`.
- **S35 (discovery)**: group **`discovery-trending-topk`** on `analytics.events`; `GET /trending?category&limit` → `{category, windowMinutes, generatedAt, items: [{rank, productId, title, priceMinor, currency, category, score}]}`; idempotent window merges.
- **S39 (experimentation)**: `POST /events` → `202 {accepted, rejected[]}`; `GET /experiments/assignments`; admin `PUT /admin/experiments/:key` (with `unit`), `POST …/start`, `POST …/stop`, `GET …/:key/results` (per variant `exposures`, `conversions`, `excluded.unattributable`); group **`experimentation-purchases`** on `orders.events` (`order.paid` → `purchase` event, `platform: "server"`, deduplicated by `eventId`).
- **S28 (notifications)**: group `notification-router` additionally on `discussion.events`; notice type `discussion.comment` (category `discussions`) for `postAuthorId`; `GET /notifications`, `/notifications/unread-count`; SSE `user:<id>` event `notification`.
- **S01 / S03**: sign-up/sign-in, admin role, shop and owner role; **S49 / S53 / S54 / S51 / S50**: the control surface of J01 (jobs, consumers, clock), explicit topics `products.events`, `discussion.events`, `feed.events`, `links.events`, `analytics.events`, `orders.events`; the journey's address on the rate-limit allow list (profiles `follow.write`, `feed.read`, `discussion.write`, `share-link.create`, `analytics.ingest`, `experiments.results`, `discovery.trending`, `discovery.recommendations` unchanged).
- **W02 / W03 (web)**: the storefront emits `product_view` and `add_to_cart` and one `exposure` per variant render, stores `ref` from the landing URL as a first-party cookie (30 days) and sends it in the checkout body; a home-feed page and a follow button need an owner (AS-34).
