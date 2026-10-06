# Feature Specification: S20 — Same-Day Courier Dispatch: Location Ingest, Offers with Timeout, Delivery State Machine, Live Tracking (domain `fulfilment`)

**Feature Branch**: `S20-courier-delivery` (spec directory `specs/domains/S20-courier-delivery`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Same-day courier dispatch: location ingest, offers with timeout, delivery state machine, live tracking (domain `fulfilment`)". Sources: `docs/showcase/sections/SD-23-same-day-courier-delivery.md`, note 10-System-Design/07-commerce-and-transactions.md §23 (ride-hailing / food delivery), patterns P0110, P0323, P0328, P1105 of `docs/architecture/pattern-map.md`. Constitution v3.1.0.

## Scope

A shop that has a paid order can ask for it to be delivered the same day. Couriers on shift stream their GPS position every few seconds; the platform keeps only the latest position in memory (a per-city geo index) and the full track as a durable, expiring history. Dispatch offers the delivery to the best nearby courier, one at a time, each offer with a timeout; the first valid acceptance assigns the delivery and no courier is ever offered or assigned two deliveries. The delivery moves through a strict state machine with a history. The buyer follows the courier live. Work is partitioned by city so that one city's load or failure stays in that city.

In scope:

- **Courier profile and shift**: register as a courier in a city with a vehicle, go on and off shift, see own status, current offer and active delivery.
- **Location ingest**: batched GPS points, validation, drop of stale or future points, in-order live position, durable history with expiry, rate limit.
- **Delivery request**: a shop member requests a delivery for a paid order of that shop; the fee is fixed at request time and is priced by surge.
- **Dispatch**: ranked candidate search with widening radii, one offer at a time, offer timeout, decline, retry when nobody is free, giving up after a fixed number of attempts, durable timers that survive restarts and lost messages.
- **Delivery state machine**: `REQUESTED → OFFERED → ASSIGNED → PICKED_UP → DELIVERED` and `CANCELLED`, with conditional transitions, a history of every transition, replay-safe courier actions, cancellation by the shop and by order or shop events.
- **Live tracking**: delivery status and throttled courier position for the buyer and the assigned courier; offers pushed to the courier.
- **Surge pricing**: demand and supply per cell computed every minute.
- **City ownership**: dispatcher instances own cities by consistent hashing with virtual nodes; cell isolation.
- **Order integration**: the deliverable-order copy built from order events; delivery progress written back to the order through the order lifecycle service.
- **Observability** of all of the above.

Out of scope (owners named):

- Pickup points, local stock, "available near me" → **S19** (same domain). Orders, payment, the order state machine, order events → **S10** (`orders`). Shops, roles, permissions → **S03**. Authentication → **S01**.
- Delivery address capture and geocoding: the shop supplies pickup and drop-off coordinates; orders carry no address (S10 models none). Automatic dispatch when an order is paid is therefore not possible; `order.paid` makes the order deliverable (see Assumptions).
- Courier onboarding, KYC, courier payouts and fees paid to couriers → **S04**, **S15**. Push and e-mail notifications about delivery progress → **S28** (consumes this capability's events).
- The realtime hub itself (SSE gateway, `Last-Event-ID` replay, fan-out) → **S51**. Scheduler and job table → **S49**. Rate limiter engine → **S50**. Outbox, consumer framework → **S53**. Problem+json filter, idempotency facility, clock, metrics, request context → **S54**.
- Screens (courier app, buyer tracking page, seller delivery screens) → web capabilities; the order page composes order and delivery in the BFF (**S48**, IX.7 R2).
- Road-network ETA ranking, batching several orders per courier, proof-of-delivery photos, geofenced pick-up and drop-off confirmation, courier un-assignment after acceptance, reading the GPS history through an API (disputes tooling): not in this release (Assumptions).
- Splitting one hot city's geo index into sub-keys: a scale-out step that does not change behaviour (Assumptions).

## User Scenarios & Testing *(mandatory)*

Notation: Berlin. Pickup `P` is Alexanderplatz; drop-off `D` is about 3 km west of `P`. Couriers `C1`, `C2`, `C3` are `AVAILABLE` about 0.3 km, 1 km and 2.5 km from `P`; `C4` is about 14 km from `P`; `C5` is about 5 km from `P`. All are registered in city `berlin` and have just reported a position. Shops `S1`, `S2`; `U1` is a `STAFF` member of `S1`, `V1` a `VIEWER` of `S1`, `U2` a member of `S2` only. `B` is a buyer who paid order `O1` (one shop order of `S1`); `B2` is another user. "Time is frozen" means tests control the clock. "The timer fires" means the test delivers the queued offer-timeout message to the real handler. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. Money is integer minor units; the base fee is 499 minor units.

Fixed limits used below (stated once): offer timeout 15 s; empty-search retry delay 20 s; at most 8 attempts per delivery (every offer and every empty search is one attempt); search radii 3, 6 and 12 km, at most 20 candidates per search; a position older than 60 s makes an `AVAILABLE` courier ineligible; a location batch has 1 to 20 points; a point is accepted if its time is at most 5 minutes in the past and at most 10 s in the future; history is kept 90 days; a route is at most 30 km; a shop has at most 200 open deliveries.

### User Story 1 — A courier goes on shift and streams positions (Priority: P1)

A courier registers once, goes on shift, and the phone sends a batch of points every ~4 s. Only the newest point drives matching; every in-window point is kept as history. Late, duplicate and absurd points are handled without harming the live position.

**Why this priority**: dispatch quality depends on position quality; this is the hot path (50 000 points/s target).

**Independent Test**: register `C1`, go available, send ordered, late, duplicate, stale and future points.

**Acceptance Scenarios**:

1. **AS-01** (registration) — **Given** user `C1` without a courier profile, **When** `POST /couriers/me {city: "berlin", vehicle: "bike"}`, **Then** `201 {id: C1, city, vehicle, status: "OFFLINE"}` parsed by the contracts schema and one courier row exists; **When** `C1` registers again with `{city: "hamburg", vehicle: "car"}` while `OFFLINE` with no live offer, **Then** `200` and the row shows the new values; **When** a `BUSY` courier or one holding a live offer registers with a different city, **Then** `409 courier_busy` and nothing changes; **When** `city` does not match `^[a-z0-9-]{2,40}$` or `vehicle` is not `bike|scooter|car` or an unknown field is sent, **Then** `400 validation_failed` naming the field; **When** no credentials, **Then** `401`.
2. **AS-02** (shift) — **Given** registered `C1`, **When** `PUT /couriers/me/availability {available: true}`, **Then** `200 {status: "AVAILABLE"}`, the stored status is `AVAILABLE`, and `C1` is searchable only after a fresh position exists (AS-17); **When** the same request is repeated, **Then** `200` and no other change; **When** `{available: false}`, **Then** `200 {status: "OFFLINE"}` and `C1` is no longer searchable; **When** `C1` is `BUSY` (holds an `ASSIGNED` or `PICKED_UP` delivery), **Then** `409 courier_busy` in either direction; **When** a user without a courier profile calls it, **Then** `403 courier_profile_required`; **When** `available` is missing or not a boolean, **Then** `400 validation_failed`.
3. **AS-03** (location batch, happy path) — **Given** `C1` `AVAILABLE`, time frozen at `T`, **When** `POST /couriers/me/locations` with three points at `T-8 s`, `T-4 s`, `T` (in any order in the array), **Then** `202 {accepted: 3, dropped: {stale: 0, future: 0}, applied: true}`; the live position is the point at `T`; `C1` is searchable at it; exactly one history message holding the three points sorted by time is produced with key `berlin`; no Postgres row is written by the request.
4. **AS-04** (out of order and duplicate) — **Given** the live position at `T`, **When** a batch arrives whose newest point is at `T-2 s`, **Then** `202 {accepted: 1, dropped: {stale: 0, future: 0}, applied: false}`, the live position stays at `T`, and the late point still reaches history; **When** the identical batch (same timestamps) is sent again, **Then** `applied: false`, live unchanged, and after the history consumer has run twice over both messages exactly one history record exists per `(courier, timestamp)` (AS-10).
5. **AS-05** (time window, exact boundaries) — **Given** time frozen at `T`, **When** points at `T-300 000 ms` and `T+10 000 ms` are sent, **Then** both are accepted; **When** points at `T-300 001 ms` and `T+10 001 ms` are sent, **Then** they are dropped and counted as `stale` and `future`, reach neither the live position nor history; **When** every point of a batch is dropped, **Then** `202 {accepted: 0, dropped: {…}, applied: false}`, no history message is produced and no live state changes.
6. **AS-06** (validation classes) — **Given** the endpoint, **When** called with each of: `points` missing, not an array or empty; more than 20 points; `lat` outside `[-90, 90]` or not a number; `lng` outside `[-180, 180]`; `ts` not an integer or `<= 0`; `accuracy` negative or above 10 000; any unknown field including `courierId` or `city` on the body or a point; a body above 32 KB, **Then** `400 validation_failed` (`413 payload_too_large` for the size case) naming the field, and nothing is stored, produced or applied (the batch is all-or-nothing for shape; only time-window failures drop single points).
7. **AS-07** (shift gating) — **Given** `C1` `BUSY` with delivery `D1`, **When** a batch arrives, **Then** the courier's live position is updated and history records it with `deliveryId = D1`, but `C1` is not added to the searchable set; **Given** `C1` `OFFLINE`, **When** a batch arrives, **Then** `202 {accepted: 0, dropped: {stale: 0, future: 0}, applied: false, reason: "off_shift"}`, and nothing is stored, indexed or produced (an off-shift courier's whereabouts are not recorded).
8. **AS-08** (identity) — **Given** the endpoint, **When** called without credentials, **Then** `401`; **When** called by a user without a courier profile, **Then** `403 courier_profile_required`; a courier can only report for themselves (there is no courier ID in the path or body); the city used is the courier's registered city.
9. **AS-09** (rate limit) — **Given** policy `fulfilment.courier-locations` (30 batches per minute per courier, fail open), **When** one courier sends 31 batches within a minute, **Then** the 31st gets `429 rate_limited` with `Retry-After` and is not applied; another courier is unaffected; **When** the limiter's store is unavailable (forced), **Then** batches are accepted and the fallback is logged and counted.
10. **AS-10** (history consumer: duplicate delivery) — **Given** a `courier.locations_reported` message with three points, **When** the history consumer receives it twice (and once more inside a bigger batch with a duplicate key), **Then** the track store holds exactly three items keyed by courier and day plus timestamp, each with `lat`, `lng`, optional `accuracy`, the `deliveryId` active at ingest if any, and an expiry 90 days after the point's time.
11. **AS-11** (history consumer: invalid payload) — **Given** messages with `lat = 95`, a missing `courierId`, a non-integer `ts`, or an unknown event version, **When** delivered, **Then** each is rejected to the dead-letter path with a reason, no item is written, and valid messages in the same batch are still written.
12. **AS-12** (history faults) — **Given** the track store returns unprocessed items on the first two attempts (forced), **When** a batch is consumed, **Then** the remainder is retried with exponential backoff and full jitter and all items end up stored once; **When** retries are exhausted (forced), **Then** the message goes to the dead-letter path and nothing partial is acknowledged; **Given** the history producer fails (forced), **When** a batch arrives, **Then** `503 location_history_unavailable` with `Retry-After` and a generic `detail`, the live position is already applied, and resending the same batch later answers `202` and yields exactly one history record per point.
13. **AS-13** (courier self view) — **Given** `C1` holding a live offer for `D1` (AS-14) or an `ASSIGNED` delivery, **When** `GET /couriers/me`, **Then** `200 {id, city, vehicle, status, currentOffer?: {deliveryId, pickup, dropoff, feeMinor, currency, expiresAt}, activeDelivery?: {deliveryId, status}}` parsed by the contracts schema, with the offer present only while it is live; a user without a profile gets `403 courier_profile_required`; `401` without credentials.

---

### User Story 2 — Dispatch offers a delivery to the nearest courier, one at a time (Priority: P1)

When a delivery is requested, the nearest eligible courier gets an offer with a 15-second timeout. If they decline or let it lapse, the next one gets it. Nobody is offered two deliveries at once, nobody who declined is asked again, and a delivery nobody takes is cancelled after 8 attempts.

**Why this priority**: this is the capability's core promise and its hardest invariant (no double assignment).

**Independent Test**: three couriers near `P`; request, decline, time out, accept; then races.

**Acceptance Scenarios**:

1. **AS-14** (nearest first, offer contents) — **Given** `C1`, `C2`, `C3` `AVAILABLE`, time frozen at `T`, **When** delivery `D1` is requested (AS-37), **Then** `D1` is `OFFERED` to `C1` with `attempt = 1` and offer expiry `T+15 s`; one offer record `OFFERED` exists for `(D1, C1, attempt 1)`; a timeout message for `(D1, berlin, C1, 1)` is queued with a 15 s delay; `C1` receives on `user:C1` a `delivery_offer {deliveryId, pickup, dropoff, feeMinor, currency, expiresAt}`; `C2` and `C3` have no offer; the history holds `REQUESTED → OFFERED` with `C1`.
2. **AS-15** (decline moves on) — **Given** AS-14, **When** `C1` calls `POST /deliveries/D1/decline`, **Then** `204`; the offer record is `DECLINED`; `D1` is `OFFERED` to `C2` with `attempt = 2`; `C1` stays `AVAILABLE` and can receive offers for other deliveries; **When** `C1` pings again, **Then** `C1` is never offered `D1` again (the exclusion is durable and does not expire), even if the cache of declined couriers was flushed.
3. **AS-16** (offer timeout) — **Given** AS-14 and the clock at `T+15 s`, **When** the timer fires, **Then** the offer record becomes `EXPIRED`, `D1` is `OFFERED` to `C2` (`attempt = 2`), `C1` receives `delivery_offer_withdrawn {deliveryId}`, the history holds `OFFERED → REQUESTED` (detail `timeout`) then `REQUESTED → OFFERED`; **When** the same message is delivered again, or a stale message arrives (wrong attempt, wrong courier, or the offer was already accepted or declined), **Then** nothing changes: no history row, no event, no new offer.
4. **AS-17** (eligibility: position freshness) — **Given** `C1` `AVAILABLE` whose newest accepted point is 61 s old, **When** a delivery is requested, **Then** `C1` is skipped and `C2` is offered; **Given** the point is exactly 60 s old, **Then** `C1` is eligible; **When** `C1` reports a fresh point, **Then** `C1` is eligible again; a courier who went `AVAILABLE` but has never reported a point is not eligible.
5. **AS-18** (widening radii, ranking) — **Given** only `C5` (about 5 km) is eligible, **When** a delivery is requested, **Then** `C5` is offered (found in the 6 km step); **Given** only `C4` (about 14 km) is eligible, **Then** nobody is offered, the delivery stays `REQUESTED`, `attempt` increases by 1 and a retry message with a 20 s delay is queued; **Given** `C1` and `C5` are eligible, **Then** `C1` (nearer) is offered first; candidates are ranked by distance ascending with the courier ID as tie-break; at most 20 candidates are considered per search.
6. **AS-19** (empty search retry) — **Given** no eligible courier, **When** the retry timer fires and a courier has become eligible (reported a fresh point, went available), **Then** that courier is offered; **When** the retry message is stale (the delivery is not `REQUESTED` or its `attempt` differs), **Then** it is ignored.
7. **AS-20** (giving up) — **Given** a delivery whose 8th attempt is consumed (a mix of declines, timeouts and empty searches), **When** the next dispatch step runs, **Then** the delivery is `CANCELLED` with reason `no_courier_available`, the buyer receives `status` on `delivery:D1`, `delivery.status_changed` is in the outbox, no further timer is queued, and a late timer message for it changes nothing.
8. **AS-21** (one live offer per courier; concurrency) — **Given** only `C1` eligible, **When** two deliveries `Da` and `Db` are requested at the same moment (`Promise.all`), **Then** exactly one of them is `OFFERED` to `C1`, the other is `REQUESTED` with a retry timer, and `C1` has exactly one live offer; **When** the same race runs after the cache entries that guard offers were deleted (forced loss), **Then** the result is the same (the store of record refuses the second live offer; the losing delivery moves on to the next candidate or retries).
9. **AS-22** (one active assignment per courier) — **Given** `C1` `BUSY` with an `ASSIGNED` delivery, **When** a new delivery is requested, **Then** `C1` is never offered it, even if the in-memory index still lists `C1` (forced stale entry); **When** two accepts for two different deliveries offered to the same courier are forced to race (offers made through a faulted guard), **Then** exactly one `ASSIGNED` delivery results for that courier and the other accept answers `409 courier_busy`.
10. **AS-23** (accept) — **Given** AS-14 and the clock before `T+15 s`, **When** `C1` calls `POST /deliveries/D1/accept`, **Then** `200` with the courier view `status = "ASSIGNED"`; the stored delivery has `courierId = C1`; the offer record is `ACCEPTED`; `C1` is `BUSY` and no longer searchable; history holds `OFFERED → ASSIGNED` by `C1`; `delivery.status_changed {status: "ASSIGNED"}` is in the outbox; the buyer receives `status` on `delivery:D1`; the pending timeout message later changes nothing.
11. **AS-24** (accept guards) — **Given** a live offer to `C1`, **When** `C3` (never offered) accepts, **Then** `404 delivery_not_found`; **When** `C2` (offered earlier, declined or expired) accepts, **Then** `409 offer_not_active`; **When** `C1` accepts after `offerExpiresAt` but before the timer has run, **Then** `409 offer_expired`, nothing changes, and the timer then moves the delivery on; **When** the delivery is `CANCELLED`, **Then** `409 invalid_delivery_transition {currentStatus: "CANCELLED", command: "accept"}`; **When** no credentials, **Then** `401`; **When** the ID is not a UUID, **Then** `400`.
12. **AS-25** (accept races) — **Given** a live offer to `C1`, **When** accept and the timeout handler run at the same moment (`Promise.all`), **Then** exactly one wins: either `D1` is `ASSIGNED` to `C1` (the timeout does nothing) or `D1` moved on to the next courier (the accept answers `409 offer_expired`), never both and never an `ASSIGNED` delivery with a second live offer; **When** accept and a shop cancel race, **Then** exactly one wins and the loser answers `409 invalid_delivery_transition`.
13. **AS-26** (courier goes off shift during an offer) — **Given** a live offer to `C1`, **When** `C1` sets `available: false`, **Then** the offer is `EXPIRED` (detail `courier_offline`), `D1` is offered to the next courier immediately, and `C1` is `OFFLINE`.
14. **AS-27** (durable timers) — **Given** `D1` `OFFERED` to `C1` and the queued timeout message lost (queue emptied, forced), **When** the clock passes the offer expiry and the recovery job runs, **Then** the offer is expired and `D1` moves on exactly as in AS-16; **Given** a `REQUESTED` delivery whose retry message was never enqueued (enqueue failed after commit, forced), **When** the recovery job runs after its due time, **Then** dispatch runs for it; **When** the recovery job and a late timer message run at the same moment, or the job runs twice at once, **Then** exactly one effect results.

---

### User Story 3 — The delivery moves through a strict state machine (Priority: P1)

Every delivery status change is a conditional transition that the data store decides, recorded in a history. Illegal moves are refused, courier actions are safe to repeat, and each transition has one effect on courier, buyer and order.

**Why this priority**: the state machine is the contract between courier, shop, buyer and the order.

**Independent Test**: drive a delivery through every command in every status, then race the commands.

**Acceptance Scenarios**:

1. **AS-28** (transition table, pure) — **Given** the six statuses and the commands `offer`, `offerLapsed`, `accept`, `pickUp`, `deliver`, `cancel`, **When** table-driven over every (status, command) pair, **Then** exactly these are allowed: `offer: REQUESTED → OFFERED`; `offerLapsed: OFFERED → REQUESTED`; `accept: OFFERED → ASSIGNED`; `pickUp: ASSIGNED → PICKED_UP`; `deliver: PICKED_UP → DELIVERED`; `cancel: REQUESTED | OFFERED | ASSIGNED → CANCELLED`; `DELIVERED` and `CANCELLED` allow nothing; an unknown command or status is a compile-time error (exhaustive switches ending in `assertNever`) and throws at run time.
2. **AS-29** (full happy path) — **Given** `D1` `ASSIGNED` to `C1`, **When** `C1` calls `POST /deliveries/D1/picked-up` then `POST /deliveries/D1/delivered`, **Then** each answers `204`; statuses are `PICKED_UP` then `DELIVERED`; the history for the whole life holds `REQUESTED → OFFERED`, `OFFERED → ASSIGNED`, `ASSIGNED → PICKED_UP`, `PICKED_UP → DELIVERED`, each with actor, timestamp and the new version (strictly increasing); `C1` is `AVAILABLE` again and searchable at the next fresh position; one `delivery.status_changed` outbox row per milestone (`REQUESTED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`), none for offer churn; the buyer receives `status` on `delivery:D1` for each.
3. **AS-30** (illegal transitions) — **Given** deliveries in each status, **When** table-driven: `picked-up` on `REQUESTED`, `OFFERED`, `PICKED_UP` by another actor, `DELIVERED`, `CANCELLED`; `delivered` on `ASSIGNED`, `DELIVERED`, `CANCELLED`; `accept` on `ASSIGNED`; `cancel` on `PICKED_UP`, `DELIVERED`, `CANCELLED`, **Then** each answers `409 invalid_delivery_transition {currentStatus, command}` and no history row, event, status or version changes (the only exception is AS-33).
4. **AS-31** (actor guards) — **Given** `D1` `ASSIGNED` to `C1`, **When** `C2` (a courier), `B` (the buyer) or `B2` calls `picked-up` or `delivered`, **Then** `404 delivery_not_found` and nothing changes; `401` without credentials; the lookup puts the caller in the predicate (no load-then-check).
5. **AS-32** (cancel by the shop) — **Given** `U1` of `S1`, **When** `POST /shops/S1/deliveries/D1/cancel {reason: "buyer_changed_mind"}` on a delivery in `REQUESTED`, **Then** `200` with the shop view `CANCELLED`, no courier effect; in `OFFERED` → the offer is `EXPIRED` (detail `cancelled`), `C1` gets `delivery_offer_withdrawn`, the cache guard is freed; in `ASSIGNED` → `C1` is `AVAILABLE` again and gets `delivery_cancelled {deliveryId}`; each writes the history row, the outbox event and the buyer's `status` push; **When** in `PICKED_UP`, `DELIVERED` or `CANCELLED`, **Then** `409 invalid_delivery_transition`; **When** `V1` (no `orders.manage`) calls it, **Then** `403`; **When** `U2` (other shop) calls it on `D1`, **Then** `404 delivery_not_found`; **When** `reason` is missing or longer than 200 characters, **Then** `400 validation_failed`; **When** no credentials, **Then** `401`.
6. **AS-33** (replay of courier actions) — **Given** `C1` already accepted `D1`, **When** `C1` calls `accept` again (also concurrently, `Promise.all`), **Then** every call answers the same `200` body, and exactly one history row, one event and one courier status change exist; likewise a repeated `decline` of an offer that is `DECLINED` answers `204`, a repeated `picked-up` after `PICKED_UP` answers `204`, a repeated `delivered` after `DELIVERED` answers `204`, each with no new row, event or order command; **When** the delivery has moved beyond the target (for example `picked-up` after `DELIVERED`), **Then** `409 invalid_delivery_transition`.
7. **AS-34** (concurrent steps) — **Given** `D1` `ASSIGNED`, **When** `picked-up` is sent twice at once, **Then** both answer `204` and exactly one `ASSIGNED → PICKED_UP` row exists; **When** `picked-up` and `cancel` race, **Then** exactly one wins; the loser answers `409`.
8. **AS-35** (order cancelled or shop deleted) — **Given** open deliveries for `O1` in `REQUESTED`, `OFFERED` and `ASSIGNED`, **When** `order.cancelled {orderId: O1, orderVersion: 9}` is delivered, **Then** each open delivery of `O1` is `CANCELLED` with reason `order_cancelled` with the same side effects as AS-32; a `PICKED_UP` delivery is not cancelled and its history gets an `order_cancelled_in_transit` note; **When** the message is delivered twice, **Then** one effect; **When** the payload is invalid, **Then** it is dead-lettered without side effects; **When** `tenancy.shop_deleted {shopId: S1}` is delivered, **Then** every open delivery of `S1` is `CANCELLED` with reason `shop_deleted`, the shop's deliveries remain readable only to their buyers and couriers, a duplicate has no further effect and an invalid payload is dead-lettered.
9. **AS-36** (order write-back) — **Given** `D1` for single-shop order `O1`, **When** `D1` becomes `ASSIGNED`, `PICKED_UP`, `DELIVERED`, **Then** after the transition has committed (never inside its transaction) the order lifecycle service receives `startFulfilment`, `ship {trackingCode: D1}`, `deliver` in that order; an `InvalidOrderTransitionError` whose current status is already the command's target or later counts as success (replay after a cancelled-and-re-requested delivery); **When** the order service fails transiently (forced, three times), **Then** the call is retried by a job with exponential backoff and full jitter, the delivery state is unaffected, and the order ends in the right status with each command applied once; **When** the order has more than one shop, **Then** no command is sent (fulfilment per shop is out of scope in S10); `OrderNotFoundError` is dead-lettered with a reason.

---

### User Story 4 — A shop requests a delivery for a paid order (Priority: P1)

A shop member requests a same-day delivery for one of the shop's paid orders. The server decides who the buyer is and what it costs; the request is safe to retry; nobody can request deliveries for someone else's order.

**Why this priority**: it is the entry point and the main tenant-isolation and money surface.

**Independent Test**: request with a paid order, a foreign order, a cancelled order, a repeated key.

**Acceptance Scenarios**:

1. **AS-37** (request, happy path) — **Given** `U1`, order `O1` of buyer `B` known as paid for `S1` (AS-55), time frozen, **When** `POST /shops/S1/deliveries` with header `Idempotency-Key` and body `{orderId: O1, city: "berlin", pickup: P, dropoff: D}`, **Then** `201` with `Location`, body `{id, orderId, status, city, pickup, dropoff, feeMinor: 499, currency, surge: 1, createdAt}` parsed by the contracts schema; the first dispatch attempt has already run, so `status` is `OFFERED` when a courier was eligible and `REQUESTED` otherwise; the stored row has the buyer taken from the order (never from the request), the fee and surge fixed, one history row, one `delivery.status_changed {status: "REQUESTED"}` outbox row written in the same transaction as the delivery.
2. **AS-38** (validation classes) — **Given** the endpoint, **When** called with each of: `orderId` missing or not a UUID; `city` not matching `^[a-z0-9-]{2,40}$`; `pickup` or `dropoff` missing, with `lat` outside `[-90, 90]` or `lng` outside `[-180, 180]`; any unknown field including `buyerId`, `feeMinor`, `surge`; **Then** `400 validation_failed` naming the field and no row is written; **When** pickup and drop-off are more than 30 km apart, **Then** `422 route_too_long`; **When** no courier is registered in `city`, **Then** `422 city_not_served`; **When** no credentials, **Then** `401`; **When** `V1` calls it, **Then** `403`.
3. **AS-39** (order rules and tenant isolation) — **Given** order `O2` of shop `S2` and `U1` (member of `S1` only), **When** `U1` requests a delivery for `O2` in `S1`, or an order ID that was never seen, or an order that does not contain `S1`, **Then** `404 order_not_found` (existence is not revealed); **When** `U2` calls `POST /shops/S1/deliveries`, **Then** `404` or `403` per the shop gate and no row; **When** the order is cancelled, **Then** `409 order_not_deliverable`; **When** an open delivery for `(O1, S1)` exists, **Then** `409 delivery_already_open`; **When** one for `(O1, S1)` is `DELIVERED`, **Then** `409 delivery_already_completed`; **When** the earlier one is `CANCELLED`, **Then** a new delivery is created.
4. **AS-40** (idempotency) — **Given** a request with key `K`, **When** it is replayed with the same body, **Then** the stored `201` status and body return, with the same `id`, and exactly one delivery row, one outbox row and one dispatch exist; **When** a request with key `K` is still in flight (a latch inside the first request), **Then** `409 idempotency_in_flight`; **When** `K` is reused with a different body, **Then** `422 idempotency_key_reuse`; **When** the header is missing, **Then** `422 idempotency_key_required`; **When** it is malformed, **Then** `422 idempotency_key_invalid`.
5. **AS-41** (concurrent requests for one order) — **Given** two requests with different keys for the same `(O1, S1)`, **When** sent at the same moment (`Promise.all`), **Then** exactly one answers `201` and the other `409 delivery_already_open`; one open delivery exists.
6. **AS-42** (open-delivery limit) — **Given** `S1` has 200 open deliveries, **When** a request is made, **Then** `409 open_delivery_limit`; **Given** 199 open, **When** two requests (different orders) race, **Then** exactly one succeeds and the shop never exceeds 200.
7. **AS-43** (request rate limit) — **Given** policy `fulfilment.delivery-request` (60 per minute per shop, fail closed), **When** the 61st request arrives within a minute, **Then** `429 rate_limited` with `Retry-After`; **When** the limiter's store is unavailable (forced), **Then** `503 rate_limiter_unavailable` (fails closed) and no row is written.
8. **AS-44** (who can see a delivery) — **Given** `D1` assigned to `C1` for buyer `B`, **When** `B` calls `GET /deliveries/D1`, **Then** `200` buyer view `{id, orderId, status, pickup, dropoff, feeMinor, currency, courier?: {vehicle, position?: {lat, lng, ts, stale}}, createdAt, updatedAt}` with `position` present only in `ASSIGNED` and `PICKED_UP` and `stale = true` when older than 60 s, and no courier ID, attempt count, offer data or internal version; **When** `C1` calls it, **Then** the courier view `{id, status, pickup, dropoff, feeMinor, currency, offerExpiresAt?}` with no buyer ID; **When** a courier holding a live offer calls it, **Then** the same courier view; **When** `B2`, `C3`, a courier whose offer was declined or expired, or a member of another shop calls it, **Then** `404 delivery_not_found`; **When** no credentials, **Then** `401`; **When** the ID is not a UUID, **Then** `400`; **When** `B` calls `GET /orders/O1/deliveries`, **Then** `200 {items: [buyer view…]}` of `B`'s deliveries for `O1` only (`B2` gets an empty list).
9. **AS-45** (shop reads) — **Given** 45 deliveries of `S1` in several statuses and some of `S2`, **When** `U1` or `V1` pages `GET /shops/S1/deliveries?status&limit=20&cursor`, **Then** pages of 20, 20 and 5 arrive ordered by creation time descending then ID descending, with an opaque cursor, no duplicates and no misses, only `S1`'s deliveries; `status` filters (an unknown status → `400`); `limit` outside 1–50, a malformed cursor or an unknown parameter → `400 validation_failed`; **When** `GET /shops/S1/deliveries/D1`, **Then** `200` shop view with the transition history `[{from, to, at, actorKind, detail?}]` (no courier ID, no coordinates of the courier); a delivery of `S2` → `404`; no credentials → `401`.

---

### User Story 5 — The buyer follows the courier live (Priority: P2)

The buyer sees status changes at once and the courier's position at most every 2 seconds while the courier is on the way. Nobody else can listen.

**Why this priority**: it is what the buyer sees; privacy of courier and buyer is the risk.

**Independent Test**: subscribe as buyer and as strangers; send pings every second.

**Acceptance Scenarios**:

1. **AS-46** (subscription policy) — **Given** `D1` `ASSIGNED` to `C1` for `B`, **When** `B` or `C1` subscribes to `delivery:D1`, **Then** allowed; **When** `B2`, a courier holding or having held an offer, a member of `S1`, an anonymous viewer, or any user for an unknown delivery ID subscribes, **Then** denied; the check is a query with the principal in the predicate on this domain's own store.
2. **AS-47** (position push, throttled) — **Given** `D1` `ASSIGNED`, `C1` reporting one point per second for 5 s, **When** the batches arrive, **Then** at most one `courier_position {lat, lng, ts}` is published per 2 s window on `delivery:D1` (2 messages for 5 s starting at the first ping), positions are not stored in the replay stream, the push is not made when `C1` has no active delivery, nor in any status other than `ASSIGNED` and `PICKED_UP`, and never after `DELIVERED` or `CANCELLED`.
3. **AS-48** (status push, replay) — **Given** each transition of `D1`, **Then** a `status {status, deliveryVersion, at}` message is published on `delivery:D1` and kept in the replay stream (a reconnecting viewer receives the latest status); the message carries no courier ID or coordinates; **When** the realtime store is unavailable (forced), **Then** the transition still commits (push is after commit and best effort), and the failure is counted and logged.

---

### User Story 6 — Fees follow demand (Priority: P3)

Where requests outnumber available couriers the fee rises, in quarter steps up to three times the base, and stays fixed for the delivery once it is requested.

**Why this priority**: it prices the marketplace's capacity honestly; it must not leak money errors or run twice.

**Independent Test**: one courier, three requests in one cell, then compute surge.

**Acceptance Scenarios**:

1. **AS-49** (surge compute) — **Given** one eligible courier in the cell of `P` and 3 delivery requests in the last 10 minutes in that cell, **When** the minutely surge job runs, **Then** the cell's surge is `3.0` (ratio 3 / max(1, supply) clamped to `1.0–3.0` in `0.25` steps), cells with ratio ≤ 1 have no entry (surge `1.0`), requests older than 10 minutes do not count, supply counts only eligible couriers in the cell; a new request in the cell is priced `feeMinor = 1 497` with `surge = 3`; **When** the job does not run for 3 minutes, **Then** surge reads as `1.0` again (surge expires, never stays high); **When** two worker instances are running, **Then** each schedule tick is computed once (job-table claim).
2. **AS-50** (fee math, pure) — **Given** surge steps `1.00 … 3.00` by `0.25` and base 499, **When** table-driven, **Then** `feeMinor = round_half_up(499 × surge)` in integer arithmetic (no floating point): `499, 624, 749, 873, 998, 1 123, 1 248, 1 372, 1 497`; property-based: for any step the fee is an integer, `≥ 499` and `≤ 1 497`, and non-decreasing in surge; the fee and surge never change after the request.
3. **AS-51** (cell hash, pure) — **Given** the canonical geohash vectors (e.g. `(57.64911, 10.40744)` at precision 11 is `u4pruydqqvj`) and `P` at precision 5, **When** table-driven, **Then** the hashes match; a point on a cell edge belongs to exactly one cell; latitude and longitude extremes encode without error.

---

### User Story 7 — Each city is dispatched by one owner and failures stay local (Priority: P3)

A city's timers, recovery and surge work are done by exactly one dispatcher instance chosen by consistent hashing with virtual nodes. Adding or losing an instance moves only a small share of cities. One city's trouble does not slow another.

**Why this priority**: it is the scaling and blast-radius story of the notes; correctness never depends on it.

**Independent Test**: pure ring properties; two worker instances with a frozen clock.

**Acceptance Scenarios**:

1. **AS-52** (ring, pure) — **Given** instance sets and 1 000 city names, **When** table-driven and property-based, **Then** ownership is deterministic and independent of the order instances are listed; with 5 instances (128 virtual nodes each) every instance owns between 10 % and 30 % of cities; adding a 6th instance moves between 8 % and 25 % of cities and every moved city goes to the new instance; removing an instance moves only that instance's cities; an empty instance set has no owner (the caller falls back to "any instance").
2. **AS-53** (ownership in operation) — **Given** two dispatcher instances heartbeating, **When** a timeout message for city `c` reaches the non-owner, **Then** it is handed back with a delay of at most 2 s and has no effect, and after 3 hand-backs any instance handles it (ownership is an optimisation, never required for correctness); **When** the owner's heartbeat expires (clock advanced), **Then** the other instance owns `c`, and the recovery job on it picks up `c`'s stuck deliveries; the recovery and surge jobs process only the cities their instance owns; an instance set seen as empty makes every instance process every city.
3. **AS-54** (cell isolation) — **Given** all per-city state (position index, courier records, offer guards, surge, demand) and the history message key, **When** inspected, **Then** every key of a city carries that city as its hash tag and the message key equals the city; **When** every dispatch operation for city `a` fails (forced fault on `a`'s keys), **Then** deliveries in city `b` are still offered, accepted and timed out within the normal times, and the failures are counted per city.

---

### User Story 8 — The order becomes deliverable and stays consistent (Priority: P2)

The fulfilment domain learns about paid and cancelled orders from events (never by reading orders) and tells the order about delivery progress through its lifecycle service.

**Why this priority**: it is the only link to orders; out-of-order and duplicate events must not create or keep a delivery for a cancelled order.

**Independent Test**: deliver `order.paid` and `order.cancelled` in every order, twice, and with bad payloads.

**Acceptance Scenarios**:

1. **AS-55** (`order.paid` consumer) — **Given** `order.paid {orderId: O1, userId: B, currency, shopOrders: [{shopId: S1,…}], orderVersion: 4}`, **When** consumed, **Then** a deliverable-order copy `{orderId, buyerId: B, shopIds: [S1], currency, status: PAID, orderVersion: 4}` exists (this domain's table); **When** delivered twice, **Then** one copy and no change; **When** the payload fails validation (missing `orderId`, `shopOrders` not an array, unknown event version), **Then** it is dead-lettered with a reason and nothing is written.
2. **AS-56** (out of order) — **Given** `order.cancelled {orderId: O1, orderVersion: 6}` arrives before `order.paid {…, orderVersion: 4}`, **When** both are consumed, **Then** the copy is `CANCELLED` at version 6 and the later older `order.paid` is ignored; a delivery request for `O1` answers `409 order_not_deliverable`; **When** `order.paid` arrives with a higher version than the stored one while `PAID`, **Then** the copy is updated (shop list and version); equal or lower versions change nothing.

---

### User Story 9 — Operators can see the system working (Priority: P2)

Every offer outcome, dispatch attempt, rejected location point, recovered timer and order write-back is counted; logs carry correlation and never GPS coordinates.

**Why this priority**: the guarantee "double assignments == 0" is only credible if it is measured.

**Acceptance Scenarios**:

1. **AS-57** (metrics and logs) — **Given** the scenarios AS-14 to AS-29, **When** the metrics endpoint is read, **Then** these are present and correct: offers by outcome (`offered`, `accepted`, `declined`, `expired`, `withdrawn`), dispatch attempts, give-ups, time from request to assignment, location points by result (`applied`, `late`, `stale`, `future`, `off_shift`), rate-limited batches, history failures, recovered timers, order write-back by result, hand-backs and dispatch failures per city, and `fulfilment_double_assignments_total` equal to `0` (computed from stored state by the recovery job: more than one live offer or active assignment per courier would increment it and raise a log line); every log line of the flows carries `requestId` or `traceId`, `deliveryId`, `courierId` where known, and `city`, and none contains coordinates, buyer addresses or tokens.

---

### Domain isolation (constitution IX, X)

1. **AS-58** (isolation, static) — **Given** the code and migrations after this capability, **When** `pnpm --dir packages/backend check:table-ownership --strict` and `check:boundaries` run, **Then** there are zero findings for the delivery part of `fulfilment`: no model or table of another domain is referenced; no foreign key to `User` or `Shop`; every new table (offer records, deliverable-order copies, idempotency and inbox rows through the S53/S54 facilities) is in `db/ownership.ts` under `domain:fulfilment` (or the infrastructure owner); the barrel exports modules, DTO types and event contracts only (no projector, job, repository or model); `api/` and `application/` import no `infra/` class.

### Edge Cases

- Clock: the courier's phone clock is wrong. Points are judged against the server clock (window of AS-05); a phone running 11 s fast has every point dropped as `future` until fixed (visible in the counts).
- A courier re-sends a batch after a network failure: every point is either already applied (`applied: false`) or new; no duplicate history record (AS-04, AS-10).
- The courier goes `OFFLINE` or the app is killed mid-delivery: an `ASSIGNED` or `PICKED_UP` delivery is not affected; the courier remains `BUSY`; positions stop and the buyer's `position.stale` becomes true (AS-44).
- A decline or timeout when the delivery was already cancelled: no effect (stale handling, AS-16).
- A shop deleted or an order cancelled while `PICKED_UP`: not cancelled; flagged (AS-35).
- Offer lock or in-memory index lost (flush, failover): offers and assignments stay correct because the store of record enforces them (AS-21, AS-22); the index is rebuilt by the next position pings.
- `order.cancelled` arrives after the delivery is `DELIVERED`: ignored.
- A courier registered in a city nobody requests deliveries for: never offered anything; costs nothing.
- Two shops of one multi-shop order request deliveries: allowed (one open delivery per `(order, shop)`); no order status command is sent (AS-36).
- Retry storms: location 429s (AS-09) and request 429s (AS-43) carry `Retry-After`; offers never retry faster than 20 s for an empty search.

## Requirements *(mandatory)*

### Functional Requirements

**Courier profile and shift**

- **FR-001**: A user can register once as a courier with a city (`^[a-z0-9-]{2,40}$`) and a vehicle (`bike | scooter | car`); re-registration updates both, except that city or vehicle cannot change while the courier is `BUSY` or holds a live offer (`409 courier_busy`) (AS-01).
- **FR-002**: A courier is `OFFLINE`, `AVAILABLE` or `BUSY`; only the courier switches `OFFLINE ↔ AVAILABLE`, `BUSY` is set and cleared only by the delivery state machine; repeating a switch is a no-op (AS-02).
- **FR-003**: Going `OFFLINE` while holding a live offer withdraws the offer and dispatches the delivery to the next courier at once (AS-26).
- **FR-004**: `GET /couriers/me` returns the profile, the live offer and the active delivery so a reconnecting app can resume (AS-13).

**Location ingest**

- **FR-005**: A batch has 1–20 points with `lat`, `lng`, integer `ts` (epoch ms) and optional `accuracy` (0–10 000); malformed shape rejects the whole batch with `400`; unknown fields are refused; the body is limited to 32 KB (AS-06).
- **FR-006**: Points older than 5 minutes or more than 10 s ahead of the server clock are dropped and counted; the rest are accepted; the response reports `{accepted, dropped: {stale, future}, applied}` and, for an off-shift courier, `reason: "off_shift"` (AS-03, AS-05, AS-07).
- **FR-007**: The live position changes only when an accepted point is newer than the live position; the update and the searchable-set membership change together, atomically, and only an `AVAILABLE` courier is searchable (AS-03, AS-04, AS-07).
- **FR-008**: Every accepted point goes to the history exactly once per `(courier, ts)`, tagged with the active delivery, retained 90 days, in a durable store fed asynchronously through a message keyed by city; positions of an `OFFLINE` courier are never recorded (AS-03, AS-07, AS-10).
- **FR-009**: The ingest request does not write to Postgres; the live position and the history message are the only effects (AS-03).
- **FR-010**: If the history message cannot be produced, the request answers `503 location_history_unavailable` after the live position was applied, and a resend is safe (AS-12).
- **FR-011**: The history consumer validates every payload, deduplicates by key, retries unprocessed items with backoff, and dead-letters poison or exhausted messages without partial acknowledgement (AS-10–AS-12).
- **FR-012**: A courier is identified only by the session; the city is the registered city (AS-08); batches are limited by `fulfilment.courier-locations` (AS-09).

**Dispatch and offers**

- **FR-013**: Dispatch searches eligible couriers around the pickup with radii 3, 6, 12 km, ranks by distance then courier ID, considers at most 20 candidates, and offers to one at a time (AS-14, AS-18). The ranking sits behind a replaceable ranking function so an ETA estimate can replace straight-line distance later.
- **FR-014**: A courier is eligible only if stored status is `AVAILABLE`, the newest accepted point is at most 60 s old, the courier holds no live offer, and the courier has not been offered this delivery before (AS-15, AS-17, AS-21).
- **FR-015**: An offer has a 15 s expiry and exactly one record `OFFERED | ACCEPTED | DECLINED | EXPIRED | WITHDRAWN`; offer records are the durable source for "who was offered what"; the offer is pushed to the courier with an absolute `expiresAt` (AS-14).
- **FR-016**: A courier holds at most one live offer and at most one active assignment, enforced by the store of record (a constraint or conditional write), not by a check-then-write and not only by an in-memory guard (AS-21, AS-22).
- **FR-017**: A decline or an expiry returns the delivery to `REQUESTED`, excludes that courier from it permanently, and dispatches again immediately (AS-15, AS-16).
- **FR-018**: Offer expiry is driven by a delayed queue message plus a durable due time stored on the delivery and a recovery job that finds overdue offers and overdue retries, so a lost message or crash delays but never strands a delivery (AS-16, AS-27); stale or duplicate timers have no effect (AS-16, AS-19).
- **FR-019**: When nobody is eligible the attempt is consumed and a retry is scheduled in 20 s; after 8 attempts the delivery is `CANCELLED` (`no_courier_available`) (AS-18–AS-20).
- **FR-020**: Accept requires the offered courier, a live offer by the store's clock, and succeeds at most once; the same courier repeating it gets the same result (AS-23–AS-25, AS-33).
- **FR-021**: Accept sets the delivery `ASSIGNED`, the courier `BUSY` and records the offer as `ACCEPTED` in one transaction; removal from the searchable set follows and is repaired by the next position ping and the recovery job if it fails (AS-23).

**State machine**

- **FR-022**: The statuses are `REQUESTED`, `OFFERED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`, `CANCELLED`; commands and allowed moves are exactly those of AS-28; the status and command types are discriminated unions and every switch ends in `assertNever` (AS-28).
- **FR-023**: Every transition is a conditional update asserting one affected row plus one history row (`from`, `to`, actor kind and ID, detail, time) and a version increment in one transaction; the history is append-only (AS-29, AS-30).
- **FR-024**: Illegal transitions answer `409 invalid_delivery_transition {currentStatus, command}` and change nothing; courier actions by anyone but the assigned (or, for accept and decline, the offered) courier answer `404 delivery_not_found` (AS-24, AS-30, AS-31).
- **FR-025**: Repeating an applied courier action by the same courier is a success with no new row, event or side effect (AS-33).
- **FR-026**: A shop member with `orders.manage` can cancel a delivery in `REQUESTED`, `OFFERED` or `ASSIGNED` with a reason; the courier is freed and told; `PICKED_UP` and later cannot be cancelled (AS-32).
- **FR-027**: Open deliveries of a cancelled order or a deleted shop are cancelled by event consumers that are idempotent and validate payloads (AS-35).
- **FR-028**: Status milestones `REQUESTED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`, `CANCELLED` publish `delivery.status_changed` through the outbox in the transition's transaction; offer churn publishes no event (AS-29, AS-37).

**Requesting a delivery**

- **FR-029**: A shop member with `orders.manage` requests a delivery for an order: required `orderId`, `city`, `pickup`, `dropoff`; the buyer, fee, surge and currency are never taken from the request (AS-37, AS-38).
- **FR-030**: The order must be known as paid, include the shop, and not be cancelled; otherwise `404 order_not_found` (not paid, foreign or unknown) or `409 order_not_deliverable` (cancelled) (AS-39, AS-55, AS-56).
- **FR-031**: At most one non-terminal delivery per `(order, shop)`, enforced by a constraint; a `DELIVERED` one blocks a new one; a `CANCELLED` one does not (AS-39, AS-41).
- **FR-032**: Route length is at most 30 km; the city must have at least one registered courier; each shop has at most 200 open deliveries, enforced race-free (AS-38, AS-42).
- **FR-033**: The request requires `Idempotency-Key` with replay, in-flight and different-body semantics (AS-40) and is limited by `fulfilment.delivery-request`, failing closed (AS-43).
- **FR-034**: The first dispatch attempt runs before the response; the response shows the resulting status (AS-37).
- **FR-035**: The fee is `round_half_up(base × surge)` in integer minor units of the order's currency, fixed at request time (AS-49, AS-50).

**Visibility and tenant isolation**

- **FR-036**: Reads put the principal in the predicate: the buyer, the assigned courier, and the courier holding the live offer see a delivery, each with their own view; every other caller gets `404` (AS-44). Shop reads and cancel put the shop ID in the predicate (AS-32, AS-45).
- **FR-037**: The buyer view never contains courier ID, offer data, attempts or version; the courier view never contains the buyer ID; the shop view never contains courier coordinates (AS-44, AS-45).
- **FR-038**: Courier position is shown to the buyer only while `ASSIGNED` or `PICKED_UP`, marked stale after 60 s (AS-44).
- **FR-039**: A buyer lists their own deliveries for an order (AS-44); a shop lists and reads its own with keyset pagination (AS-45).

**Live tracking**

- **FR-040**: The topic `delivery:<id>` admits only the buyer and the assigned courier (AS-46); positions are throttled to one per 2 s per delivery, not replayed, and sent only while `ASSIGNED` or `PICKED_UP`; status messages are replayable and free of courier identity (AS-47, AS-48).
- **FR-041**: Offers, withdrawals and courier-side cancellations are pushed on `user:<courierId>` (AS-14, AS-16, AS-32); a push failure never fails or rolls back a transition (AS-48).

**Surge**

- **FR-042**: Per cell (geohash precision 5) surge is demand in the last 10 minutes divided by max(1, eligible supply), rounded to `0.25` steps, clamped to `1.0–3.0`, computed every minute exactly once per tick, expiring after 3 minutes (AS-49).

**City ownership**

- **FR-043**: City ownership is decided by a consistent-hash ring with virtual nodes over live dispatcher instances; timers, recovery and surge are handled by the owner; non-owners hand messages back, up to 3 times, then handle them; correctness never depends on ownership (AS-52, AS-53).
- **FR-044**: Every per-city key and the history message key carry the city as the partition unit; one city's failure does not delay another (AS-54).

**Order integration**

- **FR-045**: `order.paid` and `order.cancelled` maintain a deliverable-order copy with an order-version guard, idempotently, with payload validation and dead-lettering (AS-55, AS-56).
- **FR-046**: Delivery progress is written to the order through its exported lifecycle service after commit, retried with backoff, idempotent against already-reached statuses, only for single-shop orders (AS-36).

**Operations, contracts, isolation**

- **FR-047**: Metrics and logs per AS-57; the double-assignment counter is derived from stored state.
- **FR-048**: Every error is problem+json with a stable `code`; free-text framework exceptions are not used; the codes of this capability are listed in the scenarios (all).
- **FR-049**: Every public request and response has a schema in `packages/contracts` and e2e specs parse responses with it (all HTTP scenarios).
- **FR-050**: The domain owns `Courier`, `Delivery`, `DeliveryEvent` (history), the offer records, the deliverable-order copy; it references other domains only by plain ID columns; it reads other domains only by IX.7 R1 (order lifecycle service) and R3 (order and shop events) (AS-58).
- **FR-051**: Money is integer minor units (`BIGINT`), time comes from an injected clock, and no network call happens inside a database transaction (AS-36, AS-37).

### Key Entities

- **Courier**: `{id (the user's ID, no foreign key), city, vehicle, status OFFLINE|AVAILABLE|BUSY, createdAt}`.
- **Live position** (in memory, per city): latest `{lat, lng, ts}` and status of an on-shift courier; the set of searchable couriers per city. A cache of the truth in `Courier` plus pings, never the source of truth.
- **Delivery**: `{id, shopId, orderId, buyerId, city, pickup, dropoff, status, courierId?, attempt, feeMinor, currency, surge, nextActionAt, version, createdAt, updatedAt}`; `buyerId` copied from the order.
- **Delivery offer**: `{id, deliveryId, courierId, attempt, status, offeredAt, expiresAt, respondedAt?}`; the durable "who was offered" and the guard for one live offer per courier.
- **Delivery event** (history): `{id, deliveryId, from, to, actorKind (courier|shop|system|order), actorId?, detail?, at}`.
- **Deliverable order**: `{orderId, buyerId, shopIds, currency, status PAID|CANCELLED, orderVersion}`; a copy built from order events (R3).
- **Track point** (durable history, expiring): `{courierId, day, ts, lat, lng, accuracy?, deliveryId?, expiresAt}`.
- **Surge map** (in memory, per city): cell → multiplier with an expiry.

## Cross-capability contracts

**Provides**

- HTTP (all under the global prefix `/api`; error codes as in the scenarios; schemas in `packages/contracts`: `courierSchema`, `registerCourierRequestSchema`, `availabilityRequestSchema`, `locationBatchRequestSchema`, `locationBatchResponseSchema`, `courierSelfSchema`, `requestDeliveryRequestSchema`, `deliveryShopViewSchema`, `deliveryBuyerViewSchema`, `deliveryCourierViewSchema`, `deliveryPageSchema` = `{items, nextCursor}`, `deliveryEventSchemas`):
  - Courier (session; a courier profile for all but registration): `POST /couriers/me` (`201`/`200`), `GET /couriers/me`, `PUT /couriers/me/availability {available}`, `POST /couriers/me/locations {points: [{lat, lng, ts, accuracy?}]}` (`202 {accepted, dropped: {stale, future}, applied, reason?}`).
  - Courier actions: `POST /deliveries/:deliveryId/accept` (`200` courier view), `POST /deliveries/:deliveryId/decline` (`204`), `POST /deliveries/:deliveryId/picked-up` (`204`), `POST /deliveries/:deliveryId/delivered` (`204`).
  - Buyer/courier read: `GET /deliveries/:deliveryId` (role-based view), `GET /orders/:orderId/deliveries` → `{items: [buyer view]}`.
  - Shop: `POST /shops/:shopId/deliveries` (`ShopScoped('orders.manage')`, header `Idempotency-Key`, body `{orderId, city, pickup: {lat, lng}, dropoff: {lat, lng}}` → `201 deliveryShopViewSchema`), `GET /shops/:shopId/deliveries?status&limit&cursor` and `GET /shops/:shopId/deliveries/:deliveryId` (`ShopScoped('orders.read')`), `POST /shops/:shopId/deliveries/:deliveryId/cancel {reason}` (`ShopScoped('orders.manage')`). **Consumers: courier app and seller screens (web capabilities), the order-page BFF (S48, IX.7 R2: `GET /orders/:orderId/deliveries`).**
- Realtime (hub S51): topic `delivery:<deliveryId>` events `status {status, deliveryVersion, at}` (replayable) and `courier_position {lat, lng, ts}` (live only); topic `user:<courierId>` events `delivery_offer {deliveryId, pickup, dropoff, feeMinor, currency, expiresAt}`, `delivery_offer_withdrawn {deliveryId}`, `delivery_cancelled {deliveryId}`. Policy of `delivery:` is defined by this domain's topic module.
- Events (outbox → topic `delivery.events`, key `deliveryId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId = deliveryId}`; schemas in `packages/contracts`):
  - `delivery.status_changed` v1 `{deliveryId, orderId, shopId, buyerId, status: 'REQUESTED' | 'ASSIGNED' | 'PICKED_UP' | 'DELIVERED' | 'CANCELLED', previousStatus: string | null, courierId: string | null, reason: string | null, feeMinor, currency, deliveryVersion}`; `deliveryVersion` strictly increases per delivery; one event per milestone, written in the transition's transaction. **Consumers: S28 (buyer and seller notifications); no other capability today.**
  - `courier.locations_reported` v1 (direct produce, topic `courier`, key = city) `{courierId, city, deliveryId: string | null, points: [{lat, lng, ts, accuracy?}]}`. **Consumer: this capability's history projector only.**
- Rate-limit policies (declared in S50's registry): `fulfilment.courier-locations` 30/minute per courier (fail open); `fulfilment.delivery-request` 60/minute per shop (fail closed); `fulfilment.delivery-actions` 120/minute per user (fail open) for accept, decline, picked-up, delivered, cancel and reads.
- Queue and jobs: SQS `delivery-offer-timeouts` message `{deliveryId, city, courierId, attempt}` (`courierId = ''` means "retry dispatch"); jobs registered with S49: `fulfilment.compute-surge` (every 60 s, concurrency 1), `fulfilment.recover-deliveries` (every 15 s, concurrency 1; overdue offers, overdue retries, stale index entries, double-assignment counter), `fulfilment.apply-order-lifecycle` (per transition, ≤ 8 attempts).
- Modules for the apps: `DeliveryModule` (core: HTTP), `DeliveryWorkerModule` (worker: queue consumer, jobs, order and shop event consumers), `DeliveryProjectorModule` (projector: history consumer), `DeliveryTopicsModule` (SSE gateway). Nothing else is exported: no model, repository, `CourierService`, `DispatchService`, projector, job or worker class.

**Requires**

- **S10** (`orders`): `OrderFulfilmentService.apply(orderId: OrderId, command: { type: 'startFulfilment' } | { type: 'ship'; trackingCode: string } | { type: 'deliver' }): Promise<{ status: OrderStatus; orderVersion: number }>` throwing `InvalidOrderTransitionError {orderId, currentStatus, command}` and `OrderNotFoundError` (R1). Events on `orders.events` keyed `orderId` (R3): `order.paid` v1 `{orderId, userId, currency, shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion, …}` and `order.cancelled` v1 `{orderId, userId, reason, previousStatus, orderVersion}`. Use of the commands: `startFulfilment` on first `ASSIGNED`, `ship {trackingCode: deliveryId}` on `PICKED_UP`, `deliver` on `DELIVERED`, single-shop orders only.
- **S03** (`tenancy`): `ShopScoped('orders.manage' | 'orders.read')` with the status gate; event `tenancy.shop_deleted` v1 `{shopId}`.
- **S01** (`identity`): `Firewall()`, `@User()` (`{id, …}`); the user ID is the courier ID.
- **S51** (realtime hub): `TopicRegistry.define`, `RealtimePublisher.publish(topic, type, data, {replay})`, the `user:<userId>` topic readable only by that user, SSE `Last-Event-ID` replay.
- **S53**: `outbox.append(event)` inside the domain's transaction; consumer framework (envelope check, zod validation, version guard, own consumer group, DLQ); Kafka producer with a per-call timeout.
- **S49**: job table and scheduler (`upsertSchedule`, per-job `runAt`, single-run claim); the task queue port with delayed enqueue (≤ 900 s) and DLQ.
- **S50**: the three policies above. **S54**: problem+json filter with `code`, idempotency facility (V.6), clock, metrics registry, request context.
- Infrastructure (no S-capability owns them): Redis (GEO, hash-tagged keys, Lua), DynamoDB `CourierTrack` (courier + day partitions, 90-day expiry attribute) through the Dynamo service.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 99 % of location batches are acknowledged in under 20 ms server time at 50 000 points per second across all cities; the request touches no relational database.
- **SC-002**: A courier is never offered two deliveries at once and never assigned two: zero violations across 10 000 randomised concurrent dispatch, decline, timeout and accept operations, including with the in-memory guard wiped.
- **SC-003**: 99 % of dispatch decisions (request to first offer) complete in under 200 ms at 5 000 requests per second; an offer reaches the courier's open connection within 1 s.
- **SC-004**: A delivery never stays without an owner of its next step: after any crash or lost message, an overdue offer or retry is acted on within 30 s.
- **SC-005**: 100 % of attempts by a user who is not a party of a delivery, or by another shop's member, to read, cancel or act on it are refused without revealing whether it exists.
- **SC-006**: A buyer sees a status change within 2 s and a courier position at most once per 2 s; 100 % of courier positions are hidden outside `ASSIGNED` and `PICKED_UP`.
- **SC-007**: A retried request (delivery request, accept, decline, picked-up, delivered, location batch) never produces a second effect: 100 % of replays leave counts, history and events unchanged.
- **SC-008**: Adding a dispatcher instance to five moves at most 25 % of cities, all to the new instance; one city's total failure leaves other cities' dispatch times within normal bounds.
- **SC-009**: Every GPS point is kept 90 days and then gone; no point of an off-shift courier is ever stored.
- **SC-010**: The static ownership check reports zero cross-domain findings for the delivery part of the domain.

## Assumptions

- The architectural choices fixed by the notes and the domain map are kept: latest positions in an in-memory per-city geo index, history in a durable key-value store expiring after 90 days, offers and timers through a delayed queue, state in Postgres. They are named only where a pattern requires it.
- `order.paid` carries no address, so dispatch is requested by the shop with explicit coordinates; the domain map's "consumes `order.paid` for dispatch" means "`order.paid` makes the order deliverable". Automatic dispatch needs an address in S10 (out of scope).
- Per-shop fulfilment of multi-shop orders is a S10 non-goal; for such orders deliveries exist but never move the order.
- Fixed constants (offer 15 s, retry 20 s, 8 attempts, radii 3/6/12 km, 20 candidates, 60 s freshness, 5 min / 10 s window, batch 20, route 30 km, 200 open deliveries, base fee 499, surge 1.0–3.0 by 0.25, 128 virtual nodes, 3 hand-backs) are product defaults, changeable by configuration without changing behaviour classes.
- Ranking is straight-line distance; the ranking function is replaceable (ETA is a hook, not built).
- Couriers cannot un-assign themselves after accepting, and there is no geofence on pick-up and delivery confirmation or proof of delivery in this release; the shop cancels or the order's cancellation cancels.
- A courier is a user; account deletion by S01 is not modelled (no event exists today); courier rows keep plain IDs.
- The GPS history has no read API in this release; disputes and analytics read the durable store directly through tooling outside the application.
- Push notifications of offers to a courier whose app is closed belong to S28 (via `delivery.status_changed` and a future offer event); this capability pushes only on the realtime hub.
- Splitting one very large city's index into sub-keys is a scale-out change that keeps behaviour identical.
- Maximum staleness accepted for the deliverable-order copy (R3): 30 seconds (stated in `plan.md`); a request for an order paid moments ago can answer `404 order_not_found` until the event arrives.
- Cross-domain reads: orders by R3 (events) and R1 (lifecycle writes through the owner's exported service); shop permission through S03's guard; no other cross-domain data.
