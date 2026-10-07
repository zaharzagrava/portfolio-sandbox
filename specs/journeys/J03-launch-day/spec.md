# Feature Specification: J03 — Launch Day: waiting room and seat booking, a flash sale that never oversells, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers

**Feature Branch**: `J03-launch-day` (spec directory `specs/journeys/J03-launch-day`)

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "Cross-domain journey J03: Launch day: waiting room and seat booking, flash-sale purchase without overselling, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers." Sources: constitution v3.1.0 (IV, VII, IX.7), `docs/architecture/domain-map.md`, `docs/architecture/debt-register.md` (D-7, D-8, D-11, D-12), the specs S22, S11, S23, S21, S28 and the sibling journeys J01 and J02, `interview-prep/10-system-design/07-commerce-and-transactions.md` §19, §21, §22 (admission and fencing, conditional updates, exactly-once close, server clock), and the current code of the domains `launch-events`, `orders`, `auctions`, `notifications` (see `gaps.md`).

## Scope

A brand runs a launch day. Buyers queue for seats at a launch event and book them; a limited drop goes on sale and sells exactly its units; the brand goes live and the audience chats; an auction for one signed unit ends and its winner pays. Every step that matters to a buyer or to the brand ends in a notification. Five domains and the shared platform take part. This journey proves only the **hand-offs between them**; each domain's own rules are already proven by its capability spec and are referenced, never re-tested (see `test-plan.md`).

The chain, with the kind of hand-off at each arrow (constitution IV.3, IX.7):

```
buyer ─POST …/queue─► launch-events (queue store only) ─admitter─► ticket admitted ─SSE queue:<ticket> / status poll
buyer ─POST …/holds (X-Admission-Token)─► launch-events ──R1──► identity (purpose-token verify)             [R1]
buyer ─POST /launch-holds/:id/confirm─► launch-events ─same transaction─► booking rows + outbox launch_events.booking_confirmed
                                                                                + outbox SQS command orders.booking_voucher_requested
launch-events.events ─► notifications (booking.confirmed inbox, e-mail, push)                                 [R3]
SQS command ─► orders (voucher issued, idempotent on booking-voucher:<holdId>)                                [task]
job launch-events.open-sales | expire-hold | close-event (scheduled)  ─► event status, seat map, outbox event_sold_out | event_closed

shop ─POST /shops/:id/flash-sales─► orders (S11) ──R1──► catalog (read) ;  job flash-sale.load ──R1──► catalog.applyStockDelta (−units)
catalog ─outbox catalog.product_updated─► products.events ─► discovery (search inStock)                         [R3]
buyer ─POST /checkout─► orders ─ReservationSource(FLASH)─► fast stock buckets (never oversell) ─► order RESERVED
buyer ─J01 chain─► order.paid ─► orders (convert units) ; orders.events ─► notifications (order.confirmed, shop.order_received)
orders.events flash_sale.sold_out | start_failed ─► notifications (shop owners)
job flash-sale.end → flash-sale.reconcile ──R1──► catalog.applyStockDelta (+unsold) ─outbox flash_sale.reconciled

staff ─POST /shops/:id/live, …/start─► launch-events (live) ─same transaction─► outbox live.stream_started
viewer ─POST /live/:id/comments─► launch-events ─event stream live.events─► history writer (group live-comments-history)
                                                                         └► moderation consumer (group live-moderation) ─► comment_removed
staff ─PUT …/pin─► launch-events ──R1──► catalog (product check)  ; ─SSE stream:<id> / GET /live/:id/events─► viewers

shop ─POST /shops/:id/auctions─► auctions ──R1──► catalog (read) ; job auctions.hold-stock ──R1──► catalog.applyStockDelta (−1)
bidder ─POST /auctions/:id/bids─► auctions ──R1──► tenancy (shill guard) ─outbox auction.bid_placed | leader_changed─► notifications (auction.outbid)
job auctions.close (at endsAt) ─same transaction─► outbox auction.closed + job auctions.request-order ──R1──► orders.createFixedPriceOrder (RESERVED, EXTERNALLY_HELD)
auction.closed ─► notifications (auction.won) ; winner ─J01 chain─► order.paid ─► auctions (SOLD) ─outbox auction.sold─► notifications (auction.sold)
order.cancelled (winner unpaid) ─► auctions (second chance, once) ─► notifications (auction.second_chance) ; unsold ─► catalog.applyStockDelta (+1)
```

In scope:

- The user-visible outcomes of the chain: seats booked, voucher issued, drop units sold and stock exact, chat and pin delivered and stored, auction awarded and settled, inbox items and their unread counts.
- The **eventual-consistency contract** of every asynchronous hop: maximum time to visibility on the local stack and how a client observes progress.
- The cross-domain failure modes: duplicate and out-of-order events, a consumer that is down and catches up, replay of a topic, the compensation paths (expired seat hold, expired drop hold, unpaid auction winner and second chance, failed drop load), retried requests with the same idempotency key.
- The **journey control surface** and provider doubles it relies on. The surface is the one J01 and J02 define (jobs, consumers, clock); J03 adds job types, a read-only event tap and queue-consumer pause (below).
- The hand-offs that are missing or broken in the code today (`gaps.md`).

Out of scope (owners named):

- The buy chain after `order.paid` (payment, ledger, settlement, payout, statements) → **J01**. J03 pays through the J01 chain and asserts only what a launch needs: the order status, stock, and the inbox.
- Shop creation, onboarding, plans, products and entitlement limits → **J02**. J03 re-uses J02's `sellerFixture` (verified shop on a plan with the `auctions` entitlement).
- Rules inside one domain: queue order, admission rate, fencing, seat limits, map bitmap → **S22**; buckets, admission allowance, quota, drift → **S11**; sampling, batching, moderation rules, reactions → **S23**; proxy bidding, anti-sniping, reserve, shill guard → **S21**; channels, quiet hours, preferences, caps → **S28**; order state machine, payment window → **S10**.
- Notification **delivery** (provider calls, bounces, retries) → **S28**; this journey asserts the inbox items and the unread count, which are the observable result of a routed event.
- Screens: no web capability covers launch events, drops, live streams or auction pages today (see the `test-plan.md` of S22, S23). This journey has **no UI scenario**; it is an API journey (the SSE streams are driven by a test client).

## User Scenarios & Testing *(mandatory)*

### Notation and conventions

- People and things (all created by the test through public APIs with unique names, so journeys can share a stack): shop `S` (verified, on a plan with `auctions: true`, from J02's `sellerFixture`), owner `O`, staff member `T` of `S` (role `STAFF`), another shop's member `X`, moderator/admin `A`, buyers `B1…Bn`, viewer `W`.
  - Launch event `E`: seated, `seatCount 40`, `seatsPerRow 10`, `perUserLimit 2`, `admissionRatePerSec 5`, `salesOpenAt = clock + 10 min`, `startsAt = clock + 2 h`.
  - Drop product `F` (shop `S`, regular price `5000` EUR minor units, stock `50`), sale `FS`: `units 20`, `priceMinor 2500`, `perUserLimit 1`, window `[clock + 20 min, clock + 40 min)`.
  - Stream `L` of `S`. Auction product `P` (regular `20000`, stock `3`); auction `AU`: `startingPriceMinor 1000`, `minIncrementMinor 500`, reserve `3000`, window `[clock + 5 min, clock + 65 min)`.
  - Order amounts are relational wherever a rate or minimum is configurable; one currency (`EUR`).
- No database, topic or queue is read by the test. A hand-off step is written **`[trigger] → [domain reacts] → [observable]`**. Triggers are an API call, a domain event, an SQS task or a scheduled job. Observables are public API reads, an SSE stream, the control surface, or the event tap (below).
- **Waiting** is done only by polling an observable until it shows the expected state, with the deadline of the hop's contract (table below; deadline = 2 × maximum, poll interval 250 ms, scaled by `JOURNEY_TIME_FACTOR`). A fixed sleep is a test defect. Absence ("never") is asserted only after the consumer reports `lag: 0` and the hop's maximum has elapsed on the stack clock.
- **Time is the stack clock.** Every time-driven step (sales open, hold expiry, drop window, auction end, 48 h payment window) is made due by advancing the clock through the control surface; scheduled jobs run when the shared clock passes their `runAt`. No test waits for real minutes. The journey restores the clock and resumes every consumer in `afterAll`, even on failure.
- **Provider doubles** (system edge, local profile only, refused at startup in production; constitution VII.2): the payment provider of J01 (`pm_test_visa`, `pm_test_declined`); the document extractor and the platform admin of J02; the **toxicity classifier** answers by content (a comment containing `[[toxic]]` scores `0.95`, anything else `0.05`); e-mail, SMS and push providers are log doubles, so delivery is observed through the inbox only.
- **Control surface** (J01's, admin role, local profile): `POST /api/admin/jobs` + `GET /api/admin/jobs/:jobId`; `GET /api/admin/consumers/:group`, `…/pause`, `…/resume`, `…/replay {since}`; `GET|PUT /api/admin/clock`. **J03 adds:**
  - the job allow-list gains `launch-events.reconcile-seats`, `auctions.sweep-due`, `flash-sale.verify`, `launch-events.live-reconcile`;
  - the consumer API also covers **queue consumers** (group `orders-booking-voucher` on the SQS queue of the voucher command): pause, resume, `lag` = visible messages;
  - **event tap**: `GET /api/admin/topics/:topic/messages?type=&key=&limit=` (admin, local profile, read-only) → `{items: [{eventId, type, key, version, occurredAt, payload}]}` for relayed events, used only to prove that an event with no downstream consumer was published **exactly once** and to read its payload.
- SSE streams: `GET /api/streams?topics=…` (seat map `event:<id>:seatmap`, `queue:<ticket>`, `auction:<id>`, `stream:<id>`, `user:<id>`) and `GET /api/live/:streamId/events`.
- Every error is `application/problem+json` with a stable `code` (S54).

### Eventual-consistency contract (the hops)

Maximum time from the trigger until the result is visible **on the local stack** (single deployment of every process the chain needs: core, worker, projector, realtime gateway; outbox relay interval ≤ 2 s; search index refresh ≤ 1 s). The owner of each hop must meet it; the journey tests wait on it. "Job run" means the scheduled job became due on the stack clock.

| Hop | From → to | Visible through | Max | Owner |
|---|---|---|---|---|
| H1 | job `launch-events.open-sales` run → event `ON_SALE` | `GET /launch-events/:id` (`status`) | 5 s | S22 |
| H2 | sales open → queued ticket admitted (waiting ≤ rate) | `GET …/queue/:ticket` (`admitted`, `admissionToken`); SSE `queue:<ticket>` `admitted` | 3 s | S22 |
| H3 | hold or release → seat map change | `GET …/seatmap` (`seq`, `bitmap`); SSE `event:<id>:seatmap` | 1 s | S22 |
| H4 | confirm committed → `launch_events.booking_confirmed` → booking notice | `GET /notifications`, `/unread-count`; SSE `user:<id>` `notification` | 5 s | S28 |
| H5 | confirm committed → SQS voucher command → voucher issued | `GET /orders/vouchers?launchEventId=` | 10 s | S10 |
| H6 | last seat booked → event `SOLD_OUT` (same transaction) | `GET /launch-events/:id` | 1 s | S22 |
| H7 | job `expire-hold` run → seats free | `GET …/seatmap`; `POST …/confirm` → `409 HOLD_EXPIRED` | 5 s | S22 |
| H8 | `launch_events.event_sold_out` / `event_closed` relayed | event tap | 5 s | S22 |
| H9 | job `flash-sale.load` run → sale `LOADED`, product stock lowered by `units` | `GET /shops/:id/flash-sales/:saleId`; member product read (`quantity`) | 5 s | S11 |
| H10 | `catalog.product_updated` (stock change) → search document | `GET /products/search`, `inStock` | 10 s | S32 |
| H11 | `POST /checkout` of a drop line → order `RESERVED` (synchronous) | the `202` answer; `GET /orders/:id` | 0 s | S10, S11 |
| H12 | order paid → buyer and shop-owner inbox items | `GET /notifications` | 5 s | S28 |
| H13 | `flash_sale.sold_out` / `start_failed` → shop-owner notice | `GET /notifications` (owner) | 5 s | S28 |
| H14 | order `CANCELLED` (hold expiry) → units back and buyer notice | `GET /flash-sales/:saleId` (`remainingApprox`); `GET /notifications` | 10 s | S11, S28 |
| H15 | job `flash-sale.reconcile` run → leftovers returned, sale `RECONCILED` | `GET /shops/:id/flash-sales/:saleId`; member product read | 5 s | S11 |
| H16 | `live.stream_started` / `_ended` relayed | event tap | 5 s | S23 |
| H17 | stream start / end, pin, removal → viewers | `GET /live/:id/events` (`status`, `pin`, `comment_removed`) | 0.25 s | S23 |
| H18 | comment accepted → viewers' batch | `GET /live/:id/events` (`comments`); `GET /live/:id` (`recent`) | 1 s | S23 |
| H19 | comment accepted → history | `GET /live/:id/history?minute=` | 5 s | S23 |
| H20 | toxic comment accepted → removed | `GET /live/:id`, SSE `comment_removed` | 5 s | S23 |
| H21 | bid committed → `price` push; view | SSE `auction:<id>`; `GET /auctions/:id` | 1 s | S21 |
| H22 | `auction.leader_changed` → outbid notice for the previous leader | `GET /notifications` | 5 s | S28 |
| H23 | auction end (job run) → `CLOSED` / `UNSOLD` | `GET /auctions/:id` (`status`) | 5 s | S21 |
| H24 | `auction.closed` → winner's order requested → order `RESERVED` | winner's `GET /orders` | 10 s | S21, S10 |
| H25 | `auction.closed` → `auction.won` notice | `GET /notifications` (winner) | 5 s | S28 |
| H26 | `order.paid` of the settlement order → auction `SOLD` → `auction.sold` notice | `GET /auctions/:id`; owner `GET /notifications` | 5 s | S21, S28 |
| H27 | winner's order `CANCELLED` → `SECOND_CHANCE`, offer order, notice | `GET /auctions/:id`; runner-up's `GET /orders`, `GET /notifications` | 10 s | S21, S10, S28 |
| H28 | auction `UNSOLD` / `CANCELLED` → unit returned | member product read (`quantity`) | 10 s | S21, S05 |
| H29 | a consumer resumed or replayed → `lag: 0` | `GET /api/admin/consumers/:group` | 15 s | S53 |
| H30 | any job run through the control surface → finished | `GET /api/admin/jobs/:jobId` | 5 s to start | S49 |

`order.paid` itself and everything after it inside the buy chain are J01's hops H1–H11.

A consumer that is behind exposes its lag through `GET /api/admin/consumers/:group` (`lag`, `state`); a consumer at rest reports `lag: 0`.

Canonical consumer groups of this journey: `notification-router` (S28; `orders.events`, `auctions.events`, `launch-events.events`, `billing.events`, `payments.events`), `auctions-order-results` (S21; `orders.events`: `order.paid`, `order.cancelled`), `live-comments-history` and `live-moderation` (S23; `live.events`), `orders-booking-voucher` (S10; SQS queue of the voucher command), `search-product-index` (S32, J02), `orders-payment-results`, `payments-order-copy` (J01).

---

### User Story 1 — A buyer waits fairly, books seats, and is told once (Priority: P1)

Buyers queue before sales open, are let in at a controlled rate, hold seats, and confirm. Each confirmed booking is one booking, one confirmation notice and one pre-order voucher, however the requests are retried and whichever consumer was down.

**Why this priority**: a double booking or a lost confirmation is the failure the whole launch exists to avoid, and the booking crosses three domains (launch-events, notifications, orders).

**Independent Test**: create an event, queue buyers before sales open, advance the clock, admit, hold, confirm; read the seat map, the inbox and the voucher list.

**Acceptance Scenarios**:

1. **AS-01** (queue, admit, hold, confirm) — **Given** event `E` created by `O` with `POST /shops/S/launch-events` (the status is `SCHEDULED`) and buyers `B1…B12` signed in, **When** (1) each `Bi` calls `POST /launch-events/E/queue` before sales open → *launch-events* → `201 {ticket, admitted: false, position}`; (2) the clock is advanced past `salesOpenAt` → *job `launch-events.open-sales`* (H1) → `GET /launch-events/E` `ON_SALE`; (3) the admitter admits at most 5 per second → *launch-events* (H2) → `GET …/queue/:ticket` `{admitted: true, admissionToken}` and SSE `queue:<ticket>` carried one `admitted`; (4) `B1` calls `POST /launch-events/E/holds {seats: [3, 4]}` with `X-Admission-Token` and `Idempotency-Key: k-j03-0001` → *launch-events; the token is verified through identity (R1)* → `201 {holdId, seats: [3, 4], expiresAt}`; the seat map shows 3 and 4 taken within H3 and the seat-map stream carried a `held` delta; (5) `B1` calls `POST /launch-holds/:holdId/confirm` with `Idempotency-Key: k-j03-0002` → *launch-events writes the bookings, one history row each, the outbox event and the voucher command in one transaction* → `201 {bookings: [{bookingId, seat: 3}, {bookingId, seat: 4}]}`; **Then** `GET /launch-events/E/my-bookings` of `B1` lists exactly seats 3 and 4, and the seat map shows 3 and 4 still taken with a `booked` delta. No more than 5 buyers were admitted in any second of the stack clock (the count of tickets admitted per clock second, read from the ticket statuses' `admittedAt`).
2. **AS-02** (one booking, one notice, one voucher) — **Given** AS-01 step (5), **When** `launch_events.booking_confirmed {holdId, launchEventId, shopId, userId, seats, bookingIds, confirmedAt}` → *notifications* (H4) and the command `orders.booking_voucher_requested` → *orders* (H5), **Then** `B1`'s `GET /notifications` holds exactly one item `{type: "booking.confirmed", category: "bookings", read: false, link: …}` that mentions two seats, `GET /notifications/unread-count` → `{unread: 1}`, SSE `user:<B1>` carried one `notification`, and `GET /orders/vouchers?launchEventId=E` of `B1` lists exactly one voucher `{holdId, seatCount: 2, status: "ISSUED"}`; `B2` (no booking) has no such item and no voucher; the owner `O` gets no booking notice.
3. **AS-03** (retried confirm, same key, and ten at once) — **Given** a second hold of `B2` (seat 7), **When** `B2` repeats `…/confirm` five times at once with the same key, then ten more with different keys at once, then once more after the answers, **Then** every answer is `2xx` carrying the same `bookingId`s, `GET …/my-bookings` shows one booking for seat 7, and after H4 and H5 `B2` has exactly one `booking.confirmed` item (`unread: 1`) and exactly one voucher; the same key with another hold answers `422 idempotency_key_reuse`; a missing key `422 idempotency_key_required`.
4. **AS-04** (the last seat: sold out exactly once) — **Given** all seats but one booked or held by test buyers and `B3` holding the last seat, **When** `B3`'s confirm is sent five times at once → *launch-events: one conditional update `ON_SALE → SOLD_OUT` in the booking transaction* (H6), **Then** `GET /launch-events/E` is `SOLD_OUT` at once, a further hold answers `409 EVENT_SOLD_OUT`, a join answers `409 EVENT_SOLD_OUT`, and the event tap (H8) lists exactly one `launch_events.event_sold_out {launchEventId, shopId}` for `E` (one `eventId`); the seat map shows every seat taken.
5. **AS-05** (compensation: an unconfirmed hold expires) — **Given** event `E2` and `B4` holding seat 11 (no confirm), **When** the clock is advanced by 10 minutes → *job `launch-events.expire-hold`* (H7), **Then** the seat map shows seat 11 free, `B4`'s `…/confirm` answers `409 HOLD_EXPIRED`, `B4` has no booking, no `booking.confirmed` item (after the consumer reports `lag: 0` and H4 has elapsed), no voucher, and the event tap shows no `booking_confirmed` for the hold; **When** `B5` holds seat 11, **Then** `201`; the late `expire-hold` delivered again changes nothing of `B5`'s hold.
6. **AS-06** (notification consumer down, then catch-up) — **Given** group `notification-router` paused, **When** `B6` confirms a booking, **Then** the booking exists at once (`my-bookings`), `GET /notifications` of `B6` stays empty after H4, and `GET /api/admin/consumers/notification-router` shows `lag ≥ 1`; **When** resumed, **Then** within H29 + H4 `B6` has exactly one `booking.confirmed` item and `unread: 1`.
7. **AS-07** (voucher consumer down, then catch-up; the booking never waits) — **Given** group `orders-booking-voucher` paused, **When** `B7` confirms, **Then** `201` and the booking exist at once, the confirmation notice arrives (H4) and `GET /orders/vouchers` of `B7` is empty after H5 with `lag ≥ 1`; **When** resumed, **Then** within H29 + H5 one voucher exists; **When** the same command is delivered again (a redelivery by the queue after resume, forced by pausing and resuming twice), **Then** still one voucher.
8. **AS-08** (duplicate and out-of-order events) — **Given** AS-02 completed and every observable recorded, **When** the operator replays `launch-events.events` from the journey start for group `notification-router`, **Then** `B1`'s inbox, `unread` and the voucher list are unchanged and `lag` is `0`; **When** `O` closes the event (`POST /shops/S/launch-events/E/close`) → *launch-events appends `launch_events.event_closed`* (H8), **Then** the event is `CLOSED`, further holds and joins answer `409 EVENT_CLOSED`, a confirm of an active hold answers `409 EVENT_CLOSED`, the active holds are freed within 60 s, and a replay of the topic (older `booking_confirmed` after newer `event_closed`) changes no inbox.
9. **AS-09** (the admission token belongs to its flow) — **Given** an admitted `B8`, **When** `B8` calls the hold route with (a) their ordinary access token, (b) the admission token of another event, (c) the admission token of `B1`, **Then** each answers `403 ADMISSION_REQUIRED` and nothing is held (the seat map is unchanged); **When** `B8` sends the admission token as a bearer on `GET /auth/me` or any other session route, **Then** `401` (purpose isolation across identity and launch-events); the token never appears in the app's logs (AS-39).

---

### User Story 2 — A limited drop sells exactly its units, and everyone who pays or fails is told (Priority: P1)

The brand schedules a drop. At the start many buyers check out at once; exactly the units exist, no more, no fewer. Unpaid holds return the units, the end returns the leftovers, and buyers and the brand hear about it.

**Why this priority**: an oversold drop is a financial loss; units move between four domains (orders, catalog, discovery, notifications) and must add up.

**Independent Test**: schedule a 20-unit drop, load it, run 60 buyers, pay some, let others lapse, end, reconcile; read stock, search and inboxes.

**Acceptance Scenarios**:

1. **AS-10** (schedule and load: stock moves once, search follows) — **Given** `F` with stock `50`, **When** (1) `O` calls `POST /shops/S/flash-sales` for `FS` (`202`-style `201`, status `SCHEDULED`, `F`'s stock still `50`); (2) the clock reaches `startsAt − 60 s` → *job `flash-sale.load`; orders calls catalog's stock command (R1)* (H9) → `GET /shops/S/flash-sales/FS` `LOADED` with `stats.unitsLoaded: 20` and the member read of `F` shows `quantity: 30`; (3) `catalog.product_updated` → *discovery* (H10) → `GET /products/search?q=<title>` shows `F` with `inStock: true`; **Then** the job delivered twice (a second run through the control surface) leaves stock `30` and the buckets unchanged; checkout of `F` before `startsAt` is a regular purchase at `5000` from the regular `30` and never reaches the drop's units.
2. **AS-11** (the race: exactly the units) — **Given** `FS` open and buyers `B21…B80` (60) each with `F × 1` in their cart and a distinct key, **When** all 60 call `POST /checkout` at once, **Then** exactly 20 answer `202 {status: "RESERVED", totalMinor: 2500}` and 40 answer `422 out_of_stock {flashSaleId}`; `GET /flash-sales/FS` shows `remainingApprox: 0`, `state: SOLD_OUT`; the member read of `F` still shows `quantity: 30`; the refused 40 have no order (`GET /orders` empty) and kept their carts.
3. **AS-12** (paid orders are notified, stock stays sold) — **Given** AS-11 and the J01 chain run for 5 of the 20 orders (`pm_test_visa`), **When** `order.paid` → *orders converts the units (internal)* and → *notifications* (H12), **Then** each payer has exactly one `order.confirmed` item (amount `2500`), the owner `O` has one `shop.order_received` item per paid order, `GET /flash-sales/FS` `unitsSold` (member read `stats`) is 5 and `unitsHeld` 15, and `F`'s member `quantity` is still `30`; the non-paying 15 have no item yet.
4. **AS-13** (retried checkout, same key) — **Given** a buyer `B81` with `F × 1` and one slot left (restart AS-11 with 21 units if needed), **When** `B81` sends `POST /checkout` five times at once with the same key, then again after, **Then** every answer is the same `202` or `409 idempotency_in_flight`, exactly one order exists, exactly one unit is held, and `B81`'s quota is exhausted (`422 flash_sale_limit_exceeded` for a second checkout with a new key).
5. **AS-14** (compensation: the unpaid hold lapses, units return, a late buyer gets one) — **Given** AS-12, **When** the clock is advanced by 15 minutes → *job `orders.expire-reservation`* → each of the 15 unpaid orders `CANCELLED(hold_expired)`, *orders releases the units to the buckets* and → *notifications* (H14), **Then** `GET /flash-sales/FS` shows `remainingApprox: 15`, `state: LIVE` (if the window is still open), each of the 15 buyers has exactly one `order.cancelled` item whose text names the lapsed hold, a new buyer `B82` checks out and gets `202`, and a second expiry run changes no count (units return once).
6. **AS-15** (end and reconcile: leftovers return once, accounting adds up) — **Given** AS-14 with 5 paid, `B82` unpaid held and 14 units never claimed, **When** the clock passes `endsAt` → *job `flash-sale.end`*, the holds expire, the clock passes the reconcile time → *job `flash-sale.reconcile`; orders calls catalog's stock command (R1)* (H15), **Then** `GET /shops/S/flash-sales/FS` is `RECONCILED`, the member read of `F` shows `quantity = 50 − 5 = 45` (stock before the drop minus units sold), `GET /products/search` shows `F` `inStock: true` within H10, the event tap shows exactly one `flash_sale.reconciled {unitsSold: 5, unitsReturned: 15, driftUnits: 0}`, and running `flash-sale.reconcile` again (through the control surface) changes nothing; `loaded 20 = sold 5 + returned 15`.
7. **AS-16** (the brand hears the sale sold out) — **Given** AS-11's sale reaching 0 units, **When** `flash_sale.sold_out {saleId, shopId, productId}` → *notifications* (H13), **Then** the owner `O` has exactly one item `{type: "shop.flash_sale_sold_out"}` for `FS`; a staff member `T` has none; replaying `orders.events` for `notification-router` adds none, and a later release of a unit followed by another sell-out produces no second item for the same sale (one `sold_out` per sale).
8. **AS-17** (compensation: the load fails, nothing is sold from anywhere else) — **Given** a second drop `FS2` of `F2` (stock `10`, units `10`) and the member reducing `F2`'s stock to `4` after scheduling (through the product update route), **When** the load job runs, **Then** `FS2` is `START_FAILED(insufficient_stock)`, `F2`'s quantity is still `4`, a checkout of `F2` at `startsAt` is regular (price `regular`, from `4`), the event tap shows one `flash_sale.start_failed`, and `O` has one `shop.flash_sale_start_failed` item (H13).
9. **AS-18** (notification consumer down while the drop sells, then catch-up; replay) — **Given** group `notification-router` paused, **When** 3 drop orders are paid, **Then** orders, stock and `flash-sales` stats are right at once and the inboxes are empty with `lag ≥ 1`; **When** resumed, **Then** within H29 + H12 each payer has one `order.confirmed` and `O` three `shop.order_received`; **When** `orders.events` is replayed from the journey start for the group, **Then** every inbox count and `unread` is unchanged.

---

### User Story 3 — A live stream reaches its audience, is stored, and stays clean (Priority: P2)

The brand goes live. Viewers see the stream start, the chat, the pinned product and removals; comments are stored for replay; toxic comments are removed.

**Why this priority**: the chat is lossy by design but its hand-offs (outbox start event, durable event stream, history, moderation, product check) must not lose or duplicate what is promised.

**Independent Test**: create and start a stream, connect a viewer, post comments, pin, remove, read history; end the stream.

**Acceptance Scenarios**:

1. **AS-19** (start: viewers and the event stream agree) — **Given** `L` `SCHEDULED` and viewer `W` connected to `GET /live/L/events` (first event `snapshot {status: "SCHEDULED"}`), **When** `T` calls `POST /shops/S/live/L/start` (and 20 concurrent repeats) → *launch-events writes the status and `live.stream_started` in one transaction*, **Then** `W` receives `status {status: "LIVE"}` within H17, `GET /live/L` shows `LIVE` and `startedAt`, every call answers `200`, and the event tap shows exactly one `live.stream_started {streamId, shopId, title, launchEventId, startedAt}` (H16); a non-member `X` gets `404`.
2. **AS-20** (comment: delivered, shown to late joiners, stored) — **Given** AS-19, **When** viewer `B90` calls `POST /live/L/comments {text: "Take my money!"}` → *launch-events, event stream* (H18, H19), **Then** `201 {id, authorName, text}` with a handle (no e-mail local part), `W`'s next `comments` batch contains it within H18, a viewer connecting afterwards sees it in the snapshot's `recent`, and `GET /live/L/history?minute=<current>` lists it within H19, exactly once.
3. **AS-21** (retried comment, same `clientId`) — **Given** AS-20, **When** `B90` repeats the post with the same `clientId` and text five times at once, **Then** one `201` and four `200` with the same `id`, `W` receives it once, history lists it once; a different text with the same `clientId` answers `422 client_id_reused`.
4. **AS-22** (pin: the catalog is asked, the audience is told, a foreign product is refused) — **Given** AS-19 and product `F` of `S`, **When** `T` calls `PUT /shops/S/live/L/pin {productId: F, text: "Buy now — 20 left", stockLeft: 20}` → *launch-events; product check through catalog (R1)*, **Then** `200 {version: 1, productTitle}`, `W` receives `pin` within H17, `GET /live/L` shows it; the same call with a product of another shop, an archived product or an unknown id answers `422 product_not_pinnable` (identical); a read-only member `X2` of `S` gets `403`; `DELETE …/pin` → `204` and `W` receives `pin: null` with `version: 2`.
5. **AS-23** (removal: viewers, history and the event stream agree) — **Given** AS-20, **When** `T` calls `DELETE /shops/S/live/L/comments/:id` (and 20 concurrent repeats) → *launch-events: durable removal first, then the recent list and the push*, **Then** every call answers `204`, `W` receives `comment_removed {id}` within H17, the comment is gone from `GET /live/L` and `…/history`, and the event tap shows exactly one `live.comment_removed {commentId, reason: "moderator", actorId}`.
6. **AS-24** (asynchronous moderation) — **Given** AS-19, **When** `B91` posts `"[[toxic]] hello"` (passes the synchronous checks) → *launch-events accepts it; `live-moderation` scores `0.95`* (H20), **Then** the comment appears for `W`, then within H20 `W` receives `comment_removed`, the comment leaves `recent` and history, and the event tap shows exactly one `live.comment_removed {reason: "auto", score}`; a comment with a low score stays.
7. **AS-25** (history consumer down, then catch-up; duplicates and removal before post) — **Given** group `live-comments-history` paused, **When** 5 comments are posted and one of them removed by `T`, **Then** the viewers received them and `GET /live/L` shows 4, `…/history` shows none of the new ones after H19 and the group shows `lag ≥ 1`; **When** resumed, **Then** within H29 + H19 history lists the 4 visible comments once each and never the removed one; **When** `live.events` is replayed from the start for the group, **Then** history is unchanged; and a removal that reaches history before its comment's post (replay in the order removal-first, induced by resuming `live-moderation` first) still ends with the comment not listed.
8. **AS-26** (end: connections close, the event is published once, nothing is posted afterwards) — **Given** AS-19 with `W` connected, **When** `T` calls `POST /shops/S/live/L/end` (twice) → *launch-events: status `ENDED`, pin cleared, `live.stream_ended`*, **Then** `W` receives `status {status: "ENDED"}` and the connection closes within 1 s, a new connection answers `409 stream_ended`, a comment, a reaction and a pin answer `409 stream_not_live`/`stream_ended`, the event tap shows exactly one `live.stream_ended {streamId, shopId, endedAt, durationSeconds}`, `stats` events stop within 2 s, and **no** viewer, owner or follower has a notification item for the start or end of the stream (the stream lifecycle is deliberately not notified; see Assumptions).

---

### User Story 4 — An auction closes once and its winner is settled, or the unit goes back (Priority: P1)

Bidders outbid each other; the leader who is outbid is told; at the end the auction closes once, the winner is told and gets an order at the final price; payment settles it. If the winner does not pay, the runner-up gets one chance; if nobody pays, the unit returns to the shelf.

**Why this priority**: money and one scarce unit; closing twice, awarding below the reserve, or losing the unit are the costly failures. The close crosses five domains (auctions, orders, catalog, notifications, tenancy).

**Independent Test**: create an auction, bid with three buyers, advance the clock to the end, pay the winner; repeat with an unpaid winner.

**Acceptance Scenarios**:

1. **AS-27** (schedule: the unit leaves the shelf once; the auction opens at its start) — **Given** `P` (stock `3`) and `O` with the `auctions` entitlement, **When** (1) `O` calls `POST /shops/S/auctions` for `AU` with `Idempotency-Key: k-j03-0003` (and the same key again, then five at once) → *auctions; one auction*, `201`; (2) *job `auctions.hold-stock`; auctions calls catalog's stock command (R1)* (H28) → the member read of `P` shows `quantity: 2`; (3) the clock reaches `startsAt` → *job `auctions.open`* → `GET /auctions/AU` `OPEN`; **Then** exactly one auction exists for `P`, stock was lowered once, a second create for `P` answers `409 auction_exists_for_product`; without the entitlement `403 entitlement_required`.
2. **AS-28** (bids: proxy price, the outbid leader is told once) — **Given** AS-27, **When** `B1` bids max `10000` (`leading`, price `1000`), `B2` bids `5000` (`outbid`, price `5500`), `B3` bids `12000` (`leading`, price `10500`) → *auctions; `auction.leader_changed {previousLeaderId: B1, leaderId: B3}` appended in the bid's transaction* → *notifications* (H22), **Then** `GET /auctions/AU` shows price `10500`, `bidCount 3`, an alias for the leader and no user id or maximum; `B1` has exactly one `auction.outbid` item; `B2` has none (never the leader); `B3` none; the push `price` SSE message was received within H21 with a rising `version`; a bid with `Idempotency-Key` repeated five times at once creates one bid and one notice; `B1` raising their own maximum later produces no notice.
3. **AS-29** (the seller's team cannot bid; becoming a member before the close withdraws the award) — **Given** AS-28, **When** `T` (member of `S`) bids → `403 shill_bid_forbidden`, no bid row (price unchanged); **When** the current leader `B3` is invited and accepted as a `STAFF` member of `S` before the end (S03 routes), then the clock passes the end → *job `auctions.close`; tenancy is asked outside the transaction (R1)*, **Then** `GET /auctions/AU` is `UNSOLD(leader_ineligible)`, no order is requested (winner's `GET /orders` empty after H24), `B3` has no `auction.won` item (H25), and the unit returns (member read of `P` shows `quantity: 3`, H28) exactly once. (This scenario uses its own auction `AU2`; AS-30 onward use `AU`.)
4. **AS-30** (anti-sniping moves the end; the original close job is a no-op) — **Given** AS-28 and the clock at `endsAt − 90 s`, **When** `B2` bids max `13000` (price-changing) → *auctions extends `endsAt` by the rule*, **Then** the response and `GET /auctions/AU` show the later `endsAt`; **When** the clock passes the original end, **Then** `AU` is still `OPEN` and no `auction.closed` exists on the event tap; **When** it passes the new end, **Then** the close happens (AS-31).
5. **AS-31** (close: one result, one order, one notice) — **Given** AS-30 with `B2` leading at a price ≥ the reserve, **When** the clock passes `endsAt` → *job `auctions.close`* (H23), **Then** `GET /auctions/AU` is `CLOSED` with the final price (never above the winner's maximum, never below the reserve); *`auction.closed` and the order-request job are written in the closing transaction* → *auctions calls orders' fixed-price command (R1), key `auction:<id>:winner`* (H24) → `B2`'s `GET /orders` lists one order `RESERVED` at the final price, one line, no discount, `reservedUntil` 48 h ahead; the seller's `GET /shops/S/auctions/AU` shows `winnerOrderId`; **Then** (H25) `B2` has exactly one `auction.won` item (final price shown) and no other bidder has one; the product's stock is still `2` (the unit stays held; the order moved no stock).
6. **AS-32** (the close delivered many times) — **Given** AS-31's setup on another auction `AU3` ready to close, **When** the close is triggered three times at once (control surface `auctions.sweep-due` and the scheduled job) and again afterwards, **Then** one `auction.closed` (event tap), one order for the winner, one `auction.won` item, stock unchanged; every extra delivery is a no-op.
7. **AS-33** (the winner pays: sold, with everyone told) — **Given** AS-31, **When** `B2` runs the J01 chain for the settlement order (`pm_test_visa`) → `order.paid` → *auctions' consumer* (H26) → `GET /auctions/AU` `SOLD`, `winnerOrderId` unchanged, and `auction.sold` → *notifications*, **Then** the owner `O` has one `auction.sold` item and one `shop.order_received` item (both: they are different facts), `B2` has one `order.confirmed` item besides `auction.won`; the member read of `P` is still `2` (no return after a sale); a second payment event (webhook plus payments event, J01 AS-02) changes nothing.
8. **AS-34** (compensation: the winner does not pay; the runner-up gets one chance; or the unit returns) — **Given** an auction `AU4` closed with winner `B5` (max `10000`) and runner-up `B6` (max `5000`, ≥ reserve), **When** the clock is advanced by 48 h → *job `orders.expire-reservation`* → order `CANCELLED(hold_expired)` → `order.cancelled` → *auctions' consumer* (H27), **Then** `GET /auctions/AU4` is `SECOND_CHANCE`, `B6`'s `GET /orders` lists one order at `5000` (their own maximum) with a 24 h hold, `B6` has exactly one `auction.second_chance` item, `B5` has one `order.cancelled` item (hold lapsed); **When** `B6` pays → `SOLD` with `viaSecondChance: true` and the owner is told; **Or When** the clock advances another 24 h → order cancelled → `UNSOLD(second_chance_unpaid)`, the member read of the product shows the unit returned once (H28), there is no third offer, and the auction is terminal.
9. **AS-35** (reserve not met: no winner, no order, no award notice, unit returned) — **Given** an auction `AU5` with reserve `3000` and bids reaching only `2900`, **When** the clock passes the end, **Then** `UNSOLD(reserve_not_met)`, nobody's `GET /orders` has a settlement order, no `auction.won` item exists for any bidder, the unit is returned once (H28), and the event tap shows one `auction.closed {status: "UNSOLD", reason: "reserve_not_met"}`.
10. **AS-36** (settlement consumer down; duplicates; late and out-of-order payment) — **Given** group `auctions-order-results` paused and AS-31's closed `AU6`, **When** the winner pays, **Then** the order is `PAID`, the auction stays `CLOSED` with `lag ≥ 1`; **When** resumed, **Then** within H29 + H26 it is `SOLD` once; **When** `orders.events` is replayed from the start for the group, **Then** nothing changes (status, `winnerOrderId`, one `auction.sold` on the tap); **Given** `AU4` of AS-34 after the offer started, **When** a late `order.paid` for the first (cancelled) order is delivered by replay, **Then** the auction does not leave `SECOND_CHANCE`/its current state and no second order exists (the late payment is reported as an anomaly metric, AS-39).

---

### User Story 5 — One buyer's launch day: the inbox tells the truth, with everything running at once (Priority: P1)

A buyer books seats, wins a drop unit, wins the auction and chats. The inbox shows each fact once, newest first, and the unread count matches. Meanwhile the other launch activities run, and none disturbs another.

**Why this priority**: the point of a launch day is that the pieces run together; shared consumers (`notification-router`, `orders.events`) are where cross-talk, duplicate and miscount defects show.

**Acceptance Scenarios**:

1. **AS-37** (the inbox tells the truth) — **Given** buyer `B9` who in one run holds and confirms 2 seats (AS-01), buys one drop unit and pays (AS-12), wins an auction (AS-31) and pays (AS-33), **When** all hops have completed and the consumers report `lag: 0`, **Then** `GET /notifications` of `B9` holds exactly: one `booking.confirmed`, one `order.confirmed` per paid order (2), one `auction.won`, newest first, no duplicates; `unread-count` equals the number of unread items; `POST /notifications/read {all: true}` → `{unread: 0}` (repeated: the same); SSE `user:<B9>` carried exactly one `notification` per item, with `unread` rising 1, 2, 3, 4.
2. **AS-38** (everything at once, nothing crosses) — **Given** a fresh event, drop, stream and auction on the same stack and five buyers each doing a different part of the journey, **When** the booking race (AS-03/AS-04 in miniature: 12 buyers, 6 seats), the drop race (AS-11 in miniature: 15 buyers, 5 units), 30 comments and 5 pins/removals, and 6 bids run concurrently (`Promise.all`), then the clock is advanced past every end, **Then** every invariant of its own story holds: no seat booked twice and no more bookings than seats, exactly 5 drop orders and stock exact (`loaded = sold + released + still held`), history and viewers consistent, the auction closed once with the highest maximum; no buyer's inbox contains an item of another buyer's fact; every consumer group reports `lag: 0` within H29.

---

### User Story 6 — Operators can see progress, and the boundaries hold (Priority: P3)

**Acceptance Scenarios**:

1. **AS-39** (every hop is observable) — **Given** the whole journey ran, **When** the metrics endpoint is read, **Then** counters exist and moved for: seats held and booked, queue admitted, drop reservations by result, drop stock drift (stays 0), live comments by result and history lag, auction bids by outcome, auctions closed by status, settlement anomalies (`late_payment` moved only in AS-36), notifications routed and ignored; every consumer group of the journey reports `lag: 0` and `state: RUNNING`; every log line of the journey carries a `requestId` or `traceId`; no admission token, `Idempotency-Key`, ticket-to-user mapping, comment text, e-mail address, payment reference or card reference appears in any log line, metric label or error body.
2. **AS-40** (approved paths only) — **Given** the repository, **Then** the static gates pass: `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` for the domains `launch-events`, `orders` (flash sales), `auctions`, `notifications`, `check:module-graph` (every process boots) and `check:model-registry`; `launch-events` imports no tenancy model (`ShopMembership`) and no identity internals (`KeyStore`), has no foreign key to `Shop`; `auctions` imports no `BisOrder*`/`ShopOrder` model, no `OrderService` and no `FlashStockService`, and writes no `Product`; flash-sale code writes no `Product`; `notifications` queries no `User` or `ShopMembership` table; stock moves only through catalog's exported stock command; every consumer documents its idempotency mechanism.

### Edge Cases

- A buyer in the queue whose session expires: proven in S22; the journey signs in once per actor and refreshes tokens, advancing the clock invalidates sessions, so sessions are re-created after each clock move.
- The same user is a booker, a drop buyer, a bidder and a commenter: one account, one inbox (AS-37).
- A drop and an auction on the same product: refused by each owner's own rule (S11, S21); the journey uses separate products.
- The shop is suspended during the day: S11, S21 and S23 define their own behaviour; not repeated here.
- The clock moves during the journey: the journey owns the clock for its whole run and restores it at the end; a consumer paused across a clock move catches up on its own terms (events keep their original `occurredAt`; S28's stale-event rule applies to push and SMS, never to the inbox).
- Two journeys on one stack: journey files run serially (`maxWorkers: 1`), always resume consumers and reset the clock in `afterAll`; every assertion uses the journey's unique titles, `shopId` and ids.
- Rate limits: the journey uses one account per actor and the stack's local profile allow-lists the journey's address; a `429` is a test defect except where a scenario asserts it.
- `order.cancelled` for reasons `user_cancelled` or `payment_failed` creates no notice (S28 rule); the journey's cancellations are all by hold expiry.

## Requirements *(mandatory)*

### Functional Requirements

**The chain**

- **FR-001**: Confirming a hold MUST write the bookings, their history, `launch_events.booking_confirmed` and the voucher command in one transaction, with no network call inside it; the event MUST reach notifications and the voucher command MUST reach orders without the booking waiting on either (AS-01, AS-02, AS-06, AS-07).
- **FR-002**: An event MUST become `ON_SALE` at its sales time, `SOLD_OUT` in the transaction that books the last seat (once), and `CLOSED` on organizer close or at its start; each transition MUST append its event (`event_sold_out`, `event_closed`) in the same transaction (AS-01, AS-04, AS-08).
- **FR-003**: An unconfirmed hold MUST free its seats at its expiry through a scheduled job that is safe to run late or twice; an expired hold MUST never produce a booking, an event, a notice or a voucher (AS-05).
- **FR-004**: The admission token MUST be signed and verified through identity's exported purpose-token service, bound to event and buyer, and MUST NOT be accepted as an access token nor vice versa (AS-09).
- **FR-005**: Scheduling a drop MUST NOT move stock; loading MUST lower the product's stock exactly once through catalog's stock command; the end and reconciliation MUST return exactly the unsold units once; `loaded = sold + returned (+ reported drift)` (AS-10, AS-15).
- **FR-006**: A drop checkout MUST create an order only for a buyer who got a unit; exactly the loaded units are ever sold, and a refused buyer MUST create no order (AS-11).
- **FR-007**: A lapsed drop hold MUST release its units to the bucket they came from exactly once and notify the buyer; paid units stay sold (AS-12, AS-14).
- **FR-008**: A failed load MUST leave catalog stock untouched, end the sale as `START_FAILED`, never sell the units from regular stock at the drop price, and notify the brand (AS-17).
- **FR-009**: `flash_sale.*` lifecycle events MUST be appended in the transaction of the transition, once per transition, keyed by `saleId` on `orders.events` (AS-15, AS-16, AS-17).
- **FR-010**: Starting and ending a stream MUST append `live.stream_started` / `live.stream_ended` in the status transaction, once per transition; high-volume `live.*` events go to the event stream, durable before a comment becomes visible (AS-19, AS-20, AS-26).
- **FR-011**: A pin MUST be validated against catalog through the exported lookup scoped to the shop; foreign, archived and unknown products are refused alike (AS-22).
- **FR-012**: Comment history MUST be built only from `live.events`, tolerate duplicates and any order of post and removal, and never list a removed comment (AS-23, AS-25).
- **FR-013**: Every bid MUST be durable when acknowledged; `auction.leader_changed` MUST be appended in the transaction of the bid for every actual change of leader, and the previous leader notified once (AS-28).
- **FR-014**: The unit of an auction MUST leave regular stock once when the auction is scheduled and return exactly once when the auction ends unsold or is cancelled, through catalog's stock command; never after a sale (AS-27, AS-29, AS-34, AS-35).
- **FR-015**: Closing MUST be one conditional transition, safe under duplicate triggers, awarding only a leader who is not a member of the selling shop at that moment and whose price meets the reserve; the closing transaction MUST append `auction.closed` and the order-request job (AS-29, AS-31, AS-32, AS-35).
- **FR-016**: The winner's order MUST be requested from orders through its exported command with key `auction:<id>:winner`, at the final price, without discount and without stock movement, after the closing transaction commits; orders MUST append `order.reserved` for it so that payment can proceed through the J01 chain (AS-31, AS-33).
- **FR-017**: An auction MUST reach `SOLD` only on a matching `order.paid` and MUST reach `SECOND_CHANCE` or `UNSOLD` only on a matching `order.cancelled`; the second chance is offered at most once to the highest eligible runner-up at their own maximum (AS-33, AS-34, AS-36).
- **FR-018**: Notifications MUST be derived only from events: `booking.confirmed`, `order.confirmed`, `shop.order_received`, `order.cancelled` (hold lapsed), `auction.outbid`, `auction.won`, `auction.second_chance`, `auction.sold`, `shop.flash_sale_sold_out`, `shop.flash_sale_start_failed`; the inbox item and the unread counter MUST each change exactly once per (event, recipient) (AS-02, AS-16, AS-28, AS-37).
- **FR-019**: A launch-day fact that has no notification by decision (`live.stream_*`, comments, reactions, seat holds and expiries, unsold auctions, an auction with a refused leader) MUST produce no inbox item (AS-05, AS-26, AS-29, AS-35).

**Failure modes**

- **FR-020**: Every consumer of the chain MUST be idempotent (inbox, unique key on `eventId`, or version-guarded upsert), validate its payload, and dead-letter poison messages without blocking (constitution IV.5) (AS-08, AS-18, AS-25, AS-36).
- **FR-021**: Events of one aggregate MUST be keyed by the aggregate id and consumers MUST discard an event older than the state applied (AS-08, AS-36).
- **FR-022**: A consumer or queue consumer that is down MUST lose nothing: after resuming, every fact is applied once, and its lag is visible (AS-06, AS-07, AS-18, AS-25, AS-36).
- **FR-023**: Every request that creates something or takes something scarce (`holds`, `confirm`, `checkout`, auction create and bid, comment with `clientId`) MUST be safe to retry with its key (AS-03, AS-13, AS-21, AS-27, AS-28).
- **FR-024**: A lapsed seat hold, a lapsed drop hold, a failed drop load, an unpaid auction winner and a refused auction leader MUST each leave the dependent domains consistent: no booking, no stranded or doubled unit, no stale notice (AS-05, AS-14, AS-17, AS-29, AS-34).

**Observability and control (journey support)**

- **FR-025**: Every hop in the contract table MUST meet its maximum time on the local stack and be observable through the API named in the table (all scenarios).
- **FR-026**: All five domains MUST take time only from the injected platform clock, so that advancing the stack clock makes holds, windows and auctions due; scheduled jobs of the chain MUST run when due on that clock (all time-driven scenarios).
- **FR-027**: The control surface of J01/J02 MUST additionally provide the allow-listed jobs, the queue-consumer pause/resume/lag and the read-only event tap of the notation; the local profile MUST provide the classifier double; each is refused at startup in production.
- **FR-028**: The journey MUST drive and observe only through public APIs, SSE, the control surface and the event tap; it MUST resume paused consumers and reset the clock even when it fails.

**Safety**

- **FR-029**: A user MUST see only their own tickets, holds, bookings, vouchers, orders, notifications and maximum; staff routes of one shop MUST answer `404` for another shop; public pages and streams expose public fields only (spot-checked in AS-01, AS-09, AS-19, AS-22, AS-28).
- **FR-030**: Events, logs, notices and error bodies MUST NOT carry an admission token, an idempotency key, a comment author's e-mail, an auction maximum or reserve amount, or a payment reference (AS-28, AS-39).

### Key Entities

- **Launch event / ticket / hold / booking / voucher**: the seated event, a buyer's place in the waiting room, a 10-minute claim on seats, a confirmed seat, and the pre-order voucher issued by orders for a booking.
- **Drop (flash sale) / claim / drop order**: the scheduled limited sale, a buyer's units taken from it, and the order that holds them.
- **Live stream / comment / pin**: the broadcast, a chat message, and the one pinned product.
- **Auction / bid / settlement order**: the English auction, a bidder's maximum, and the order for the winner or the runner-up.
- **Inbox item / unread counter**: what a buyer or a shop owner sees for an event.
- **Consumer group**: a named subscription of one domain to topics or a queue, with state and lag.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When 60 buyers race for 20 drop units, exactly 20 orders exist and exactly 20 units are accounted for (sold, held or returned) in 100% of runs; at the end, shelf stock plus sold units equals the stock before the drop in 100% of runs.
- **SC-002**: No seat has more than one confirmed booking and no buyer holds or books more than the event's limit, in 100% of runs, including when bookings, the drop and the auction run at the same time.
- **SC-003**: From a confirmed booking to the buyer's confirmation notice: at most 5 seconds in 99% of runs; to the issued voucher: at most 10 seconds in 99% of runs.
- **SC-004**: From a paid order to the buyer's and the shop owner's notices: at most 5 seconds in 99% of runs.
- **SC-005**: A comment reaches viewers within 1 second and the stored replay within 5 seconds in 99% of runs; a toxic comment is gone from every viewer within 5 seconds in 99% of runs.
- **SC-006**: Each auction closes once and requests each settlement order once; the winner's order is visible within 10 seconds of the end in 99% of runs; 0 auctions are awarded below their reserve or to a member of the selling shop; every auctioned unit is either sold or back on the shelf exactly once.
- **SC-007**: Under any retry or replay pattern of the journey (same key five times at once, topics replayed, consumers paused and resumed), every buyer and shop owner has exactly one notice per fact: 0 duplicates and 0 missing in 100% of runs.
- **SC-008**: With any one consumer of the journey paused during its step and resumed afterwards, 0 facts are lost and 0 are applied twice; the lag returns to 0 within 15 seconds of resuming.
- **SC-009**: The journey runs from a clean local stack to green in under 15 minutes with 0 fixed sleeps and 0 real-time waits longer than the hop deadlines.

## Assumptions

- Every default below is also a line in `questions.md`; those that change an existing contract are tagged `[BREAKING]` there.
- **Decision policy**: where the codebase and the notes disagree, the production-grade option wins (events through the outbox, R1/R3 only, version-guarded consumers, idempotency keys on every scarce or creating call, the injected clock), because there are no external clients to keep compatible.
- **The booking voucher is its own thing in orders**: orders consumes the voucher command and keeps a voucher (not an order) readable at `GET /orders/vouchers`, because a seat is free and the voucher must not enter the payment state machine; it is best-effort for the booking (S22 FR-035).
- **Live stream lifecycle is not notified.** S23 allows S28 to notify followers of `live.stream_started`; there is no follower relationship that S28 may query for a shop's stream except marketing feed items (S26), so the default is no notification; the event is still published and asserted through the event tap.
- **Drop events are notified to the shop owners for two facts only**: sold out and failed load (the two a brand must act on); other `flash_sale.*` events have no notification. `flash_sale.oversold` is an operator alert (S11 metric), not an inbox item.
- **A drop buyer is notified through the generic order types** (`order.confirmed`, `order.cancelled`); there is no drop-specific buyer notice.
- **The auction winner gets `auction.won` when the auction closes** (the order is requested a moment later); the order itself raises no inbox item (S28 maps `order.paid` and `order.cancelled`, not `order.reserved`).
- **A settled auction produces two owner items** (`auction.sold` and `shop.order_received`) because they are two distinct facts of two domains; S28 does not merge them.
- **Time is the stack clock.** Constants of the domains (10-minute hold, 15-minute drop hold, 48-hour and 24-hour auction payment windows) stay constants; the journey advances the clock instead of changing them.
- **The event tap exists for events with no consumer** (stream, drop and event lifecycle) and for "exactly once" proofs; it is a read-only local-profile admin route, never used to drive anything.
- **No web UI scenario**: no capability covers these pages yet; when one is added it owns its UI journey and this journey stays the API proof.
- **One currency** (`EUR`); the amounts of the notation are illustrative, assertions are relational wherever a price, limit or rate is configurable. A journey owns the stack clock while it runs; journeys run serially.

## Cross-capability contracts

Searched before writing: `grep -rl` over `specs/domains specs/web specs/journeys` for `J03` and `journeys` (plus `launch day`). Contracts the earlier specs require from this journey, and how they are honoured:

- **S22** (spec Cross-capability, `test-plan.md`): "J03 will consume `launch_events.booking_confirmed`, the seat map and the queue endpoints"; the cross-domain happy path (waiting room, seat booking, voucher, notification) belongs to `packages/backend/test/journeys`. Honoured: AS-01 to AS-09. S22 asks S10 to consume `orders.booking_voucher_requested` (honoured and **specified further** here: the voucher and its read route, `[CONTRACT]`).
- **S23** (spec): "J03 consumes `live.stream_started`, the stream routes, the event connection, `stats` and the pin"; the cross-domain happy path (booking, flash sale, live comments, auction) belongs to J03. Honoured: AS-19 to AS-26 (`stats` is asserted in AS-26 only as "stops after end"; its content is S23's).
- **S21** (spec, questions): J03 expects "an auction closing with the winner's checkout and the notifications each triggers" satisfied by `auction.closed` + the winner's `RESERVED` order + S28; no extra contract. Honoured: AS-31 to AS-36. **Differs / adds** (as `[CONTRACT]`): S21 names no consumer group for `orders.events`; this journey fixes `auctions-order-results`; S21 relies on S10's `createFixedPriceOrder` which S10 does not provide yet.
- **S11** (spec): `flash_sale.*` events on `orders.events` keyed by `saleId`; "consumers: none required today; S28, S40, S36 and J01 may subscribe". Honoured: AS-15 to AS-17. **Adds**: S28 subscribes for `sold_out` and `start_failed` (`[CONTRACT]`).
- **S28** (spec): notice types `booking.confirmed`, `order.confirmed`, `shop.order_received`, `order.cancelled`, `auction.outbid`, `auction.won`, `auction.second_chance`, `auction.sold`. Honoured: AS-02, AS-12, AS-14, AS-28, AS-31, AS-33, AS-34. **Differs**: S28 does not list `launch-events.events` as a topic of its router (it lists the S22 event in Requires) and has no drop types; this journey adds the two `shop.flash_sale_*` types.
- **J01**: the buy chain (checkout, payment, `order.paid`) and the control surface. Honoured: AS-12, AS-33, AS-34 use J01's chain; the surface is extended (below).
- **J02**: `sellerFixture` (verified shop with plan), the webhook receiver and fixtures are re-used; the consumer groups `search-product-index` and the search hops H9/H10 are J02's.

**Provides** (J03 has no runtime exports; it provides tests, fixtures and a timing contract):

- `packages/backend/test/journeys/launch-day.journey-spec.ts` (top-level `describe` "Journey J03: launch day", one nested `describe` per user story).
- `packages/backend/test/journeys/support/` additions to J01/J02's kit: `launchFixture` (event, drop, stream, auction creation helpers over the public routes), `sseClient` wrappers for `queue:`, `event:…:seatmap`, `auction:`, `stream:`, `user:` and `GET /live/:id/events`, `eventTap(topic, filter)`, and `waitForContract(hop, probe)` rows H1–H30.
- **The hop table** under "Eventual-consistency contract": H1–H30 with maximum times; owners listed there must not exceed them.
- **The canonical consumer-group names** listed there.

**Requires** (owner and exact shape assumed):

- **S22 (launch-events)**: `POST /shops/:shopId/launch-events`, `POST …/:eventId/close`, `GET /launch-events/:eventId`, `POST …/queue`, `GET …/queue/:ticket` (owner only; `admitted`, `admissionToken`, `admittedAt`), `POST …/holds` (`X-Admission-Token`, `Idempotency-Key`), `POST /launch-holds/:holdId/confirm` (`Idempotency-Key`), `GET …/seatmap`, `GET …/my-bookings`; topics `queue:<ticket>`, `event:<id>:seatmap`; events on `launch-events.events` keyed as in S22: `launch_events.event_created`, `booking_confirmed {holdId, launchEventId, shopId, userId, seats, bookingIds, confirmedAt}`, `event_sold_out {launchEventId, shopId}`, `event_closed {launchEventId, shopId, reason}`; SQS command `orders.booking_voucher_requested` v1 `{holdId, bookingIds, launchEventId, shopId, userId, seatCount}` (dedupe `booking-voucher:<holdId>`); jobs `launch-events.open-sales`, `expire-hold`, `close-event`, `reconcile-seats`; purpose tokens through identity (R1).
- **S23 (live)**: routes of S23's Provides (`POST /shops/:shopId/live`, `…/start`, `…/end`, `PUT|DELETE …/pin`, `DELETE …/comments/:id`, `POST /live/:id/comments`, `GET /live/:id`, `GET /live/:id/history`, `GET /live/:id/events`); events `live.stream_started`, `live.stream_ended` (outbox, topic `launch-events.events`), `live.comment_posted`, `live.comment_removed` v2 (topic `live.events`); consumer groups **`live-comments-history`**, **`live-moderation`**; the classifier double by content (local profile).
- **S11 (flash sales)**: `POST /shops/:shopId/flash-sales`, `GET /shops/:shopId/flash-sales/:saleId` (`status`, `stats {unitsLoaded, unitsRemaining, unitsHeld, unitsSold}`), `GET /flash-sales/:saleId` (`state`, `remainingApprox`); checkout codes `out_of_stock {productIds, flashSaleId}`, `flash_sale_limit_exceeded`; jobs `flash-sale.load`, `.end`, `.reconcile`, `.verify`; events `flash_sale.loaded|ended|reconciled|cancelled|start_failed|sold_out|oversold` on `orders.events` keyed `saleId`; stock only through `ProductStockService.applyStockDelta` (operation ids `orders:flash:<saleId>:load|return`).
- **S21 (auctions)**: routes of S21's Provides (`POST /shops/:shopId/auctions`, `GET /auctions/:id`, `POST /auctions/:id/bids`, `GET /shops/:shopId/auctions/:id` with `status`, `statusReason`, `winnerOrderId`); events on `auctions.events` keyed `auctionId`: `auction.created|opened|bid_placed|leader_changed {previousLeaderId, leaderId, priceMinor, currency}|closed {status, winnerId, finalPriceMinor, currency, reserveMet, reason}|second_chance_offered {offeredToId, priceMinor, currency, expiresAt}|sold {buyerId, finalPriceMinor, currency, orderId, viaSecondChance}|unsold|cancelled`; consumer group **`auctions-order-results`** on `orders.events` (`order.paid`, `order.cancelled`; inbox, version guard, zod, DLQ); jobs `auctions.open`, `.close`, `.sweep-due`, `.request-order`, `.hold-stock`, `.return-stock`; stock only through `applyStockDelta` (`auctions:<id>:hold|return`); membership through `ShopAccessService.getRole`.
- **S10 (orders)**: `POST /checkout` with drop sources (S11's seam); `OrderCommandService.createFixedPriceOrder(command)` as in S21's Requires, appending `order.reserved` for the new order; `GET /orders` listing the buyer's orders including settlement orders; **new**: consumer group **`orders-booking-voucher`** of `orders.booking_voucher_requested` (idempotent on `booking-voucher:<holdId>`) and `GET /orders/vouchers?launchEventId=&limit&cursor` → `{items: [{voucherId, holdId, launchEventId, shopId, seatCount, status: "ISSUED", createdAt}], nextCursor}` for the caller; `orders.expire-reservation` (15 minutes; 48 h and 24 h for auction orders).
- **S28 (notifications)**: consumer group **`notification-router`** on `orders.events`, `auctions.events`, `launch-events.events`, `billing.events`, `payments.events`; notice types of the table above, **plus new** `shop.flash_sale_sold_out` (`flash_sale.sold_out`, recipients: shop OWNERs of `shopId`, category `shop`, channels `push`, `inapp`) and `shop.flash_sale_start_failed` (`flash_sale.start_failed`, same recipients, `email`, `inapp`); `GET /notifications`, `/notifications/unread-count`, `POST /notifications/read`; realtime `notification` on `user:<id>`.
- **S05 (catalog)**: `ProductStockService.applyStockDelta`, `ProductQueryService.getProductsByIds(ids, {shopId})`, product read for members with `quantity`; `catalog.product_updated` on every stock change.
- **S01 (identity)**: `PurposeTokenService.sign/verify` (R1); admin role; sessions. **S03 (tenancy)**: `ShopScoped`, `ShopAccessService.getRole`, member invite and accept routes (AS-29). **S32 (discovery)**: `search-product-index`. **J01**: `POST /payments/intents`, order and payment routes, `orders-payment-results`, `payments-order-copy`.
- **S49 (jobs) / S53 (consumers, topics) / S54 (clock)**: the control surface of J01 and its J03 additions; every job of the chain runs from the injected clock; topics `launch-events.events`, `auctions.events`, `live.events`, `orders.events` created explicitly.
- **S50 (rate limits)**: the journey's address on the allow list; named policies of S22, S11, S23, S21 unchanged.
