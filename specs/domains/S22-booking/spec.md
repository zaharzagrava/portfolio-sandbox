# Feature Specification: S22 — Launch-Event Booking (waiting room, admission tokens, seat holds, booking confirm, seat map, ticket limits) — domain `launch-events`

**Feature Branch**: `S22-booking` (spec directory `specs/domains/S22-booking`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S22 — Launch-event booking: waiting room, admission tokens, seat holds, booking confirm, seat map, ticket limits (domain `launch-events`)." Sources: `docs/showcase/sections/SD-21-launch-event-booking.md`; note `10-System-Design/07-commerce-and-transactions.md` §21 (ticket booking); constitution v3.1.0; `docs/architecture/domain-map.md` (`launch-events`); `docs/architecture/pattern-map.md` rows P0110, P0304, P0311, P0312, P0323, P0326, P0414, P0619; the current code of `packages/backend/libs/domains/launch-events/` (booking part only; the live stream is S23).

## Scope

In scope:

- **Launch events for brands**: a shop's staff creates a launch event (a seated or general-admission event with a fixed number of seats and a sales-opening time), sees its bookings, and closes it.
- **Virtual waiting room**: buyers join a queue before or after sales open; pre-sale arrivals are ordered randomly so refreshing early gives no advantage; the room admits buyers at a fixed rate per second; each buyer sees a position and an estimated wait; a buyer who leaves loses the spot.
- **Admission token**: an admitted buyer receives a short-lived signed token bound to the event and the buyer; the booking steps refuse anything without it, before touching any store.
- **Seat holds**: an admitted buyer holds specific seats (or the best available ones) for 10 minutes; exactly one buyer wins a seat; holds expire by themselves; multi-seat holds are all-or-nothing.
- **Booking confirmation**: a hold becomes a booking exactly once, even with retries, races against expiry, and crashes between stores; the database refuses two confirmed bookings for one seat.
- **Seat map**: a cheap, cacheable picture of which seats are taken, with ordered change notifications; display only, never the authority.
- **Ticket limits**: a per-person limit of seats per event (held plus booked).
- **Protection under load**: queue-length cap (load shedding), rate limits, a bot-check hook at the room entrance, and defined behaviour when a store is down.
- **Observability** of all of the above.

Out of scope (owners named):

- The live comment and reaction stream of an event, pinned commerce, moderation → **S23** (`launch-events`, same domain, separate capability).
- The pre-order voucher itself, its pricing and its payment → **S10** (`orders`) and **S13** (`payments`). This capability only asks S10 for a voucher with a command after a booking is confirmed (cross-domain write, IV.3); a booking never waits on it. Booking cancellation and refunds are not offered here.
- Flash-sale admission (`orders`, S11) has its own admission limit and is not a consumer of this room.
- Sending notifications → **S28**. Realtime transport, topic registry and replay → **S51**. Job scheduling → **S49**. Rate-limit engine → **S50**. Outbox and Kafka relay → **S53**. Problem+json filter, config validation, health, shedding primitives → **S54**.
- Edge/CDN configuration and the CAPTCHA widget in the browser. This capability verifies a bot-check result; it does not render one.
- "Verified account" gating and device fingerprinting: not offered (see Assumptions).
- A web UI: no web capability covers launch events yet (see `test-plan.md`).

## Clarifications

Decided unattended; each is also in [`questions.md`](questions.md), BREAKING and CONTRACT first.

- Seat identity is a number `0 … seatCount − 1`; row = ⌊seat ÷ seatsPerRow⌋. Seated events accept explicit seats or a quantity; general-admission events accept a quantity only.
- The seat hold lasts exactly 10 minutes. The admission token lasts exactly 10 minutes and opens the hold endpoint only; confirming or releasing an existing hold needs the session, not the token.
- Hold and confirm requests require an `Idempotency-Key`. Cross-user access to a ticket or a hold answers `404`.
- Booking confirmation is free of money: the seat itself is not priced; the pre-order voucher is a separate, asynchronous command to S10.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A buyer waits fairly and is let in at a controlled rate (Priority: P1)

A launch event goes on sale at a fixed time and thousands of people arrive at once. They join a queue, see their place and a wait estimate, and are admitted at a rate the booking tier can sustain. Early arrivals get no edge by refreshing; people who walk away stop blocking others.

**Why this priority**: without it the booking tier is flattened at sale start and nobody books anything.

**Independent Test**: create an event with admission rate 10/s, join 100 buyers (half before the sales time), advance the clock, and check who is admitted each second, their tokens, positions, and the queue behaviour under shedding.

**Acceptance Scenarios**:

1. **AS-01 (join)** — **Given** an event `SCHEDULED` or `ON_SALE` and an authenticated buyer, **When** the buyer calls `POST /api/launch-events/:eventId/queue`, **Then** `201 queueStatusSchema` `{ticket, admitted: false, position: ≥ 1, queueLength, etaSeconds, heartbeatSeconds: 120, expiresAt}`, a `Location` to the ticket status, and no row is written to the relational database or the hold ledger (only the queue store is touched).
2. **AS-02 (join is idempotent per buyer and event)** — **Given** a buyer already holding a ticket for the event, **When** they join again, **Then** `200` with the same `ticket` and unchanged position; **Given** one buyer sending 20 joins at once, **Then** exactly one ticket exists, queue length grew by 1, exactly one response is `201` and 19 are `200` with the same ticket.
3. **AS-03 (pre-sale order is random, refresh gives no edge)** — **Given** the queue-ordering rule, **When** scores are computed for joins before `salesOpenAt` and at/after it, **Then** every pre-sale join scores uniformly at random inside `[salesOpenAt, salesOpenAt + 1 s)` regardless of the join instant; every join at or after `salesOpenAt` scores `max(now, salesOpenAt + 1 s)`, so all pre-sale joiners are ahead of all post-open joiners, and post-open joiners are ordered by join instant (table-driven over join instants and a seeded random source).
4. **AS-04 (admission at a fixed rate)** — **Given** admission rate `N` = 10/s, 100 waiting tickets, and sales open, **When** the admitter runs for one second, **Then** exactly 10 tickets (the 10 first in global order within the position tolerance of AS-06) are admitted, never 11; with fewer than `N` waiting, all of them are; **Given** the admitter was down for 5 s, **Then** the next second admits at most `N` (bucket capacity is one second of rate, no catch-up burst).
5. **AS-05 (token content and delivery)** — **Given** a ticket is admitted, **Then** its status returns `{admitted: true, admissionToken, tokenExpiresAt}`; the token is a signed token (algorithm pinned, issuer `marketplace`, audience `admission:<eventId>`, subject = the buyer, ticket as `jti`, purpose `admission`, lifetime exactly 10 minutes); the realtime topic `queue:<ticket>` receives one `admitted` event `{eventId, admissionToken, tokenExpiresAt}`; a token past its lifetime is refused by AS-18 and the buyer must join again (new ticket, back of the line).
6. **AS-06 (position and wait estimate)** — **Given** sales are open and a ticket at true global rank `r`, **When** the status is polled at different times, **Then** `position` is within 16 places of `r`, never increases between two polls while sales are open, and `etaSeconds = ceil(position ÷ admissionRatePerSec)`; before sales open, position may change as others join (the random pre-sale order).
7. **AS-07 (heartbeat and abandonment)** — **Given** a ticket whose owner has not called the status endpoint for more than 120 s, **When** the admitter reaches it, **Then** it is removed without consuming admission capacity (the next ticket is admitted in its place within the same second); **Given** the owner polls at least every 120 s, **Then** the ticket stays; **Given** the owner returns after removal, **Then** status answers `404 TICKET_NOT_FOUND` and a new join creates a fresh ticket at the back (post-open) or a fresh random position (pre-sale).
8. **AS-08 (one admitter, stale leaders cannot admit)** — **Given** two worker instances racing for the admitter role on every tick, **When** 10 consecutive seconds elapse with admission rate `N`, **Then** total admitted ≤ `10 × N` and no ticket is admitted twice; **Given** a paused instance whose lease expired and another instance took over, **When** the paused one resumes and tries to admit, **Then** its writes are rejected (its fencing epoch is stale) and admitted count is unchanged.
9. **AS-09 (join validation, authentication, event state)** — **When** a buyer joins with a malformed event ID, **Then** `400 validation_failed`; unknown event `404 EVENT_NOT_FOUND`; no credentials `401`; **Given** event `CLOSED`, **Then** `409 EVENT_CLOSED` and nothing is queued; **Given** event `SOLD_OUT`, **Then** `409 EVENT_SOLD_OUT`.
10. **AS-10 (ticket privacy, IDOR)** — **Given** buyer A's ticket, **When** buyer B calls `GET /api/launch-events/:eventId/queue/:ticket`, **Then** `404 TICKET_NOT_FOUND`, identical to an unknown or expired ticket; no credentials `401`; a ticket of event X asked under event Y answers `404`.
11. **AS-11 (load shedding at the entrance)** — **Given** the queue has reached the configured maximum length, **When** a new buyer joins, **Then** `503 WAITING_ROOM_FULL` with `Retry-After: 5`, nothing is enqueued, and no store other than the queue store was read or written; **Given** a buyer who already holds a ticket, **Then** their join/status still succeeds; **Given** the queue store is unreachable, **Then** `503 WAITING_ROOM_UNAVAILABLE` with `Retry-After: 2`, the relational database and hold ledger are not queried, and the problem body carries no store error text.
12. **AS-12 (join rate limit)** — **Given** policy `launch.queue.join.user` (10 per minute per user), **When** one buyer sends 11 join requests for different events within a minute, **Then** the 11th is `429` problem+json with `Retry-After`; **Given** the limiter store is down, **Then** joins proceed (fail open, joins are idempotent) and a failure counter increases.
13. **AS-13 (bot-check hook)** — **Given** an event with `humanCheckRequired: true`, **When** a buyer joins with a missing, malformed or rejected `X-Human-Check` result, **Then** `403 HUMAN_CHECK_FAILED` and nothing is enqueued; a valid result joins normally; a result is accepted once (reuse → `403 HUMAN_CHECK_FAILED`); an event without the flag ignores the header.
14. **AS-14 (bot-check provider outage fails closed)** — **Given** `humanCheckRequired: true` and the verification provider timing out (2 s timeout) or answering 5xx, **When** a buyer joins, **Then** `503 WAITING_ROOM_UNAVAILABLE` with `Retry-After: 2`, nothing is enqueued, at most one verification attempt is made per request.

---

### User Story 2 — An admitted buyer holds seats and exactly one buyer wins each seat (Priority: P1)

An admitted buyer picks seats (or asks for the best available) and gets a 10-minute hold. When 100 people click the same seat, one gets it and 99 are told immediately.

**Why this priority**: the core promise of the product — never sell a seat twice, never lock a seat forever.

**Independent Test**: seed an on-sale event, admit buyers, fire 100 concurrent holds on seat 42, then multi-seat, best-available, expiry, limit, and fault cases.

**Acceptance Scenarios**:

1. **AS-15 (hold specific seats)** — **Given** an on-sale seated event (800 seats, per-person limit 2), an admitted buyer, and `Idempotency-Key`, **When** the buyer calls `POST /api/launch-events/:eventId/holds {seats: [42, 43]}` with `X-Admission-Token`, **Then** `201 holdSchema` `{holdId, eventId, seats: [42, 43], expiresAt = now + 10 min, serverTime, limit: {perUser: 2, remaining: 0}}`; the hold ledger has the hold `HELD` and one seat record per seat; the seat map shows 42 and 43 taken and a `held` delta `{seq, change: "held", seats: [42, 43]}` is published; an expiry job exists for `expiresAt`; no relational booking row exists.
2. **AS-16 (100 clicks on one seat)** — **Given** 100 admitted buyers, **When** all hold seat 42 at the same time (`Promise.all`), **Then** exactly one `201` and 99 `409 SEAT_TAKEN {seat: 42}`; the ledger holds exactly one hold for seat 42; every loser's quota is unchanged.
3. **AS-17 (multi-seat is all-or-nothing)** — **Given** buyer A holds seat 10, **When** buyer B holds `[9, 10]`, **Then** `409 SEAT_TAKEN {seat: 10}`, seat 9 is free again (A can hold it), and nothing of B's remains in the ledger, the fast lock store, the seat map or B's quota; **Given** B's rollback runs after seat 10 was meanwhile re-held by C, **Then** C's hold is untouched (a rollback removes only what its own hold wrote).
4. **AS-18 (the admission token is checked first)** — **Given** an authenticated buyer, **When** they call the hold endpoint with: no token; a malformed token; an expired token; a token for another event; a token of another buyer; a token with a different purpose or audience; a token signed with another algorithm (`none`, `HS256`); or an ordinary access token, **Then** each answers `403 ADMISSION_REQUIRED` and **no** store (relational, ledger, lock, quota) was read or written; **Given** a valid token, **Then** it may be used for several holds until it expires; **Given** any request, **Then** the token string never appears in logs, problem bodies, metrics labels or events.
5. **AS-19 (hold validation)** — **When** seats are `[]`, more than 10 entries, non-integers, negative, both `seats` and `quantity`, neither, or unknown properties, **Then** `400 validation_failed` listing the fields; duplicate entries are collapsed (`[5, 5]` holds one seat); a seat ≥ `seatCount` → `422 UNKNOWN_SEAT {seat}`; `seats` on a general-admission event → `422 SEATS_NOT_SELECTABLE`; no state changes in any of these.
6. **AS-20 (event status gates the hold)** — **Given** status `SCHEDULED`, **Then** `409 EVENT_NOT_ON_SALE`; `SOLD_OUT` → `409 EVENT_SOLD_OUT`; `CLOSED` → `409 EVENT_CLOSED`; unknown event `404 EVENT_NOT_FOUND`; the status checked is the authoritative stored status, not the cached event page.
7. **AS-21 (per-person ticket limit)** — **Given** limit 2, **When** the buyer holds 3 seats, **Then** `422 TICKET_LIMIT_EXCEEDED {limit: 2, remaining: 2}`; holding 1 then 1 succeeds (`remaining` 1 then 0); a third hold of 1 → `422 {limit: 2, remaining: 0}`; a refused hold leaves the quota exactly as before.
8. **AS-22 (limit under concurrency)** — **Given** limit 2, **When** one buyer fires 5 holds of 1 seat each (different seats) at once, **Then** exactly 2 are `201` and 3 are `422 TICKET_LIMIT_EXCEEDED`, and the buyer's held-plus-booked seats equal 2.
9. **AS-23 (limit counts holds and bookings; freed exactly once)** — **Given** limit 2 and a buyer with one confirmed booking and one active hold, **Then** a further hold → `422`; **When** the hold is released **and** the expiry job runs for it at the same time, **Then** the buyer's quota rises by exactly 1 (never 2), and a later hold of 1 succeeds but a second one fails with `422`.
10. **AS-24 (the quota counter is rebuilt, not trusted)** — **Given** limit 2, a buyer with two `CONFIRMED` bookings, and the fast quota counter wiped, **When** they hold 1 more seat, **Then** `422 TICKET_LIMIT_EXCEEDED {remaining: 0}` (the counter is recomputed from bookings and active holds); the counter has an expiry.
11. **AS-25 (hold idempotency)** — **Given** a hold request with `Idempotency-Key: K`, **When** it is replayed with the same body, **Then** the stored status and body are returned with `Idempotent-Replayed: true`, the same `holdId`, one quota claim, one ledger hold; five concurrent requests with `K` → one hold, the others `409 idempotency_in_flight` or the replay; **When** `K` is reused with different seats, **Then** `422 idempotency_key_reuse`; a missing key → `422 idempotency_key_required`; an invalid key → `422 idempotency_key_invalid`; a hold that failed with `409 SEAT_TAKEN` replays that same `409`; a `5xx` releases the key.
12. **AS-26 (best-available)** — **Given** a general-admission event of 100 seats and 50 admitted buyers, **When** each requests `{quantity: 2}` at once, **Then** all 50 get `201` with disjoint seat pairs (a pair is two adjacent seats of one row whenever one is free), no request waits on another's lock, the 51st request gets `409 NO_SEATS_AVAILABLE` with nothing held; **Given** `quantity` larger than the free seats, **Then** `409 NO_SEATS_AVAILABLE` and no partial hold.
13. **AS-27 (stale holder cannot touch a reassigned seat)** — **Given** buyer A's hold expired, buyer B holds the same seat, **When** A calls confirm or release (late) or A's delayed rollback runs, **Then** A gets `409 HOLD_EXPIRED` (confirm) or `204` (release, nothing changed), and B's hold, B's seat record and the seat map are untouched; every seat record carries a per-seat fencing number that grows with each new hold and every write against it is conditional on it.
14. **AS-28 (expiry frees everything)** — **Given** a hold of seats 5, 6, **When** the clock passes `expiresAt` and the expiry job runs, **Then** hold state `EXPIRED`, seat records freed, quota −2, seat map bits cleared, `released` delta published; **Given** the job is delayed by an hour, **Then** another buyer can already hold seat 5 at `expiresAt + 1 ms` (an expired hold counts as free), and the late job changes nothing of theirs; running the job twice changes nothing the second time.
15. **AS-29 (fast lock store down)** — **Given** the fast lock store refuses commands, **When** 20 buyers hold the same seat at once, **Then** exactly one `201` and 19 `409 SEAT_TAKEN` (correctness comes from the durable ledger), a degradation counter increases, and the response `serverTime` is present.
16. **AS-30 (durable ledger down)** — **Given** the hold ledger is unreachable or times out, **When** a buyer holds a seat, **Then** `503 HOLDS_UNAVAILABLE` with `Retry-After: 2`, no lock, quota, seat-map or booking effect remains, the problem body is generic; the seat map and queue endpoints keep answering.
17. **AS-31 (hold rate limit and limiter failure)** — **Given** policy `launch.hold.user` (30 per minute per user), **When** the 31st hold attempt arrives, **Then** `429` with `Retry-After` and no store effect; **Given** the limiter store is down, **Then** `503 HOLDS_UNAVAILABLE` (fail closed) and nothing is held.
18. **AS-32 (authentication)** — **When** a hold, confirm, release, queue join, ticket status or `my-bookings` request has no credentials, **Then** `401`; the public reads (event page, seat map) answer without credentials.

---

### User Story 3 — A hold becomes a booking exactly once (Priority: P1)

The buyer confirms inside the 10-minute window. The booking is stored once even if the request is retried, races the expiry, or the system crashes halfway; the database itself refuses a second booking for the seat.

**Why this priority**: bookings are the durable record; a double booking is the failure the whole design exists to prevent.

**Independent Test**: hold, confirm, replay, race confirm against expiry and against itself, inject a fault between stores, then verify the booking table, history and outbox.

**Acceptance Scenarios**:

1. **AS-33 (confirm)** — **Given** an active hold of seats 42, 43 owned by the caller and `Idempotency-Key`, **When** `POST /api/launch-holds/:holdId/confirm`, **Then** `201 confirmResponseSchema` `{holdId, eventId, bookings: [{bookingId, seat: 42}, {bookingId, seat: 43}], confirmedAt}`; two `Booking` rows `CONFIRMED`, one history row per booking, outbox row `launch_events.booking_confirmed` and the voucher command row, all written in one transaction with no network call inside it; the hold is `CONFIRMED`, the seat records never expire, the seat map still shows 42, 43 taken with a `booked` delta; the quota is unchanged.
2. **AS-34 (confirm idempotency)** — **Given** the same key replayed, **Then** stored `201` + body with `Idempotent-Replayed: true`, no new rows or outbox rows; **Given** a new key on an already confirmed hold of the same buyer, **Then** `200` with the same bookings and no new rows or events; the same key used on another hold → `422 idempotency_key_reuse`; missing key `422 idempotency_key_required`; concurrent duplicates with one key → one confirmation, others `409 idempotency_in_flight` or the replay.
3. **AS-35 (ten confirms at once)** — **Given** one active hold, **When** 10 confirms with different keys race (`Promise.all`), **Then** every response is `2xx` carrying the same booking IDs, exactly 2 booking rows exist for a 2-seat hold, exactly one `booking_confirmed` outbox row and one voucher command.
4. **AS-36 (confirm races expiry)** — **Given** an active hold at `expiresAt − 1 ms`, **When** confirm and the expiry job run concurrently (repeated 20 times with fresh holds), **Then** exactly one outcome per hold: either bookings exist and the job changed nothing, or the hold is `EXPIRED`, no booking exists, the confirm answered `409 HOLD_EXPIRED`, and the seats are free; never both and never a booking on a freed seat.
5. **AS-37 (illegal transitions)** — **Given** a hold in state `EXPIRED`, **When** confirm, **Then** `409 HOLD_EXPIRED`; state `RELEASED` → `409 HOLD_RELEASED`; confirm at or after `expiresAt` by the server clock (even if the expiry job has not run) → `409 HOLD_EXPIRED` and the seats are freed; **Given** state `CONFIRMED`, **When** release, **Then** `409 HOLD_ALREADY_CONFIRMED` and the booking is untouched; release of a `RELEASED` or `EXPIRED` hold → `204` and no change; **Given** event `CLOSED`, **When** confirm, **Then** `409 EVENT_CLOSED`.
6. **AS-38 (the database is the final guard)** — **Given** the hold ledger was wiped by a fault so two holds both believe they own seat 7, **When** both confirm at once, **Then** exactly one `201` and the other `409 SEAT_TAKEN {seat: 7}`; a multi-seat confirm where one seat is already booked writes nothing; a query for seats with more than one `CONFIRMED` booking returns zero rows.
7. **AS-39 (cross-user access)** — **Given** buyer A's hold, **When** buyer B confirms or releases it, **Then** `404 HOLD_NOT_FOUND`, byte-identical to an unknown hold ID, and A's hold is unchanged; confirm and release need the session only (no admission token).
8. **AS-40 (confirm validation)** — **When** the hold ID is not a UUID, **Then** `400 validation_failed`; unknown hold → `404 HOLD_NOT_FOUND`; any body field → `400`.
9. **AS-41 (crash and fault recovery)** — **Given** the confirm fails after the ledger step and before the booking is written (injected fault), **When** the buyer retries with the same key, **Then** the first answer was a generic `5xx` problem (key released), the retry succeeds with one set of bookings; **Given** the booking exists but the ledger/seat map still shows the seat as held or free, **When** the reconciler runs (every 60 s), **Then** the ledger and map agree with the booking; **Given** the ledger says confirmed but no booking exists for more than 120 s, **Then** the seat is released and a `launch_reconcile_repairs_total{kind}` counter increases.
10. **AS-42 (outbox failure rolls the booking back)** — **Given** the outbox append is refused, **When** confirm runs, **Then** `500` generic problem+json, no booking row, no history row, the hold still `HELD` and confirmable, nothing published.
11. **AS-43 (sold out exactly once)** — **Given** one seat left unbooked, held by buyer A, **When** A's confirm is sent 5 times at once with different keys, **Then** after the single booking transaction the event is `SOLD_OUT` by one conditional update, exactly one `launch_events.event_sold_out` outbox row exists, event page cache is invalidated, and further holds answer `409 EVENT_SOLD_OUT`.
12. **AS-44 (voucher command)** — **Given** a confirmed booking, **Then** one single-consumer command `orders.booking_voucher_requested` v1 is emitted with dedupe key `booking-voucher:<holdId>`; **Given** the orders capability never consumes it, **Then** the booking is unaffected; a replayed confirm creates no second command.

---

### User Story 4 — Everyone sees a cheap, ordered seat map (Priority: P2)

The seat map is a tiny public picture of taken seats, cached for a second and updated by ordered deltas. It is a hint: the hold is the authority.

**Why this priority**: it carries the read load (100k requests/s) without touching databases, but correctness does not depend on it.

**Independent Test**: hold and book seats, read the map, replay deltas out of order against the rules, wipe the map store and read again.

**Acceptance Scenarios**:

1. **AS-45 (seat map read)** — **Given** seats 1 and 2 held and seat 3 booked, **When** an anonymous caller calls `GET /api/launch-events/:eventId/seatmap`, **Then** `200 seatMapSchema` `{eventId, seatCount, seatsPerRow, seq, bitmap}` where `bitmap` is base64 of `ceil(seatCount ÷ 8)` bytes, seat `i` is bit `7 − (i mod 8)` of byte `⌊i ÷ 8⌋`, bits 1, 2, 3 are 1 and all others 0; header `Cache-Control: public, s-maxage=1`; unknown event `404 EVENT_NOT_FOUND`.
2. **AS-46 (ordered deltas)** — **Given** 50 concurrent holds on 50 different seats, **When** their `held` deltas are collected from the realtime topic `event:<eventId>:seatmap`, **Then** every delta has a unique `seq`, sorting by `seq` gives a total order consistent with the final bitmap, and the `seq` in a map read taken after all holds is ≥ every delta's `seq` for changes already in that bitmap; the bitmap bit and the `seq` of one change are assigned atomically (a reader never sees a bit without a `seq` at least that of its change).
3. **AS-47 (client delta rule)** — **Given** a client with map at `seq` 10, **When** deltas arrive `11`, `13`, `12`, `12` (gap, out of order, duplicate), **Then** the rule "apply only `seq = last + 1`; ignore `seq ≤ last`; on a gap, refetch the map" yields the final bitmap equal to the server's after the refetch and applies no delta twice (pure reducer, table-driven).
4. **AS-48 (map store loss is repaired)** — **Given** the seat-map key is lost, **When** the map is read, **Then** it is rebuilt from the authoritative state (confirmed bookings plus active holds) behind a single flight (20 concurrent reads cause one rebuild), `200` with the correct bitmap, the key has an expiry; **Given** a bit is set for a seat with no hold or booking for > 120 s, **When** the reconciler runs, **Then** the bit is cleared and a `released` delta is published.
5. **AS-49 (public reads are limited and cached)** — **Given** policy `launch.seatmap.ip` (600 per minute per address, fail open), **When** the 601st read arrives, **Then** `429` with `Retry-After`; limiter down → reads still answer; **When** `GET /api/launch-events/:eventId` is called anonymously, **Then** `200 launchEventSchema` with `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` and no admission rate, no `humanCheckRequired` secret fields beyond the boolean, no internal IDs other than `id` and `shopId`; unknown event `404 EVENT_NOT_FOUND` with a negative-cache of 5 s.
6. **AS-50 (map push is public, queue push is private)** — **Given** the realtime gateway, **When** an anonymous client subscribes to `event:<eventId>:seatmap`, **Then** allowed; **When** a client subscribes to `queue:<ticket>`, **Then** allowed only for the authenticated owner of that ticket (another user or no credentials is refused with the same answer as an unknown ticket); an `admitted` event reaches only the owner.

---

### User Story 5 — Shop staff create, watch and close a launch event (Priority: P2)

A brand's staff creates the event with seat count, sales time, limit and admission rate, sees who booked, and closes it when needed.

**Why this priority**: no event, no booking; but it is a low-traffic path.

**Independent Test**: create events as roles of one shop and as an outsider; list bookings; close; check statuses and events.

**Acceptance Scenarios**:

1. **AS-51 (create an event)** — **Given** a member of shop S with `products.write`, **When** `POST /api/shops/:shopId/launch-events` with `{title, venue, startsAt, salesOpenAt, seatCount, seatsPerRow?, seatingMode?: "SEATED" | "GENERAL", perUserLimit?, admissionRatePerSec?, humanCheckRequired?}`, **Then** `201 launchEventSchema` (response DTO, never the stored row), `Location`, status `SCHEDULED`, defaults `seatsPerRow 20`, `seatingMode SEATED`, `perUserLimit 2`, `admissionRatePerSec 200`, `humanCheckRequired false`; one `LaunchEvent` row without a foreign key to `Shop`; outbox `launch_events.event_created`; an open-sales job at `salesOpenAt` and a close job at `startsAt`.
2. **AS-52 (create validation and authorization)** — **When** `seatCount` is 0 or > 100000, `perUserLimit` 0 or > 10, `admissionRatePerSec` 0 or > 100000, `seatsPerRow` 0, > 500 or > `seatCount`, `salesOpenAt` in the past by more than 60 s, `salesOpenAt` ≥ `startsAt`, a non-ISO date, an unknown field, or title/venue over 120/200 characters, **Then** `400 validation_failed` (or `422 invalid_schedule` for the date rules) and nothing is stored; no credentials `401`; role `VIEWER` → `403 permission_denied`; a non-member of shop S → `404`; a suspended shop → the shop-status gate's answer.
3. **AS-53 (organizer list of bookings, cross-tenant)** — **Given** shop S with 130 bookings on its event, **When** a member with `orders.manage` calls `GET /api/shops/:shopId/launch-events/:eventId/bookings?limit=50`, **Then** `200 {items: [{bookingId, holdId, seat, userId, confirmedAt}], nextCursor}` ordered `confirmedAt DESC, bookingId DESC`, pages of 50, 50, 30, no duplicates or gaps; `limit` > 100 or an invalid cursor → `400`; **Given** event E belongs to shop T, **When** a member of S asks for E under S, **Then** `404 EVENT_NOT_FOUND`, identical to an unknown event; `VIEWER` → `403`.
4. **AS-54 (close an event)** — **Given** an event `ON_SALE` with 3 active holds, a queue and no bookings, **When** `POST /api/shops/:shopId/launch-events/:eventId/close`, **Then** `200 launchEventSchema` `status: "CLOSED"`, history row, outbox `launch_events.event_closed` once, event page cache invalidated, the queue is cleared and further joins `409 EVENT_CLOSED`; within 60 s the 3 holds are `EXPIRED` and their seats freed; confirming one earlier answers `409 EVENT_CLOSED`; **Given** an already `CLOSED` event, **Then** `409 EVENT_ALREADY_CLOSED`; a member of another shop → `404`; two concurrent closes → one `200`, one `409`.
5. **AS-55 (sales open)** — **Given** event `SCHEDULED` with `salesOpenAt = T`, **When** the open-sales job runs at or after `T` (delivered twice), **Then** status `ON_SALE` by one conditional update, a history row once, the event page cache invalidated; a hold at `T − 1 s` → `409 EVENT_NOT_ON_SALE`; the admitter performs the same conditional update if the job is late (the update happens once); the job on an event that is already `CLOSED` or `SOLD_OUT` changes nothing.
6. **AS-56 (state machine)** — **Given** the event states `SCHEDULED, ON_SALE, SOLD_OUT, CLOSED` and the hold states `HELD, CONFIRMED, RELEASED, EXPIRED`, **When** every (state, action) pair is evaluated, **Then** only these transitions are allowed — event: `SCHEDULED→ON_SALE`, `ON_SALE→SOLD_OUT`, `SCHEDULED|ON_SALE|SOLD_OUT→CLOSED`; hold: `HELD→CONFIRMED`, `HELD→RELEASED`, `HELD→EXPIRED` — and every other pair is rejected with its conflict code; each state-to-state mapping is exhaustive (an unhandled state fails the type check) (table-driven).
7. **AS-57 (my bookings)** — **Given** buyer A with 2 bookings and buyer B with 1 on the same event, **When** A calls `GET /api/launch-events/:eventId/my-bookings`, **Then** `200 {items: [{bookingId, seat, confirmedAt}]}` with exactly A's 2 bookings, newest first; B's are never included; unknown event `404`.

---

### User Story 6 — Operators can trust and observe the system (Priority: P3)

Operators see queue length, admission rate, hold outcomes, degradations and the double-booking detector (which must stay zero); logs never leak tokens.

**Why this priority**: it does not change what buyers can do, but the launch-day run depends on it.

**Independent Test**: run the flows above and read metrics, logs and the ownership check.

**Acceptance Scenarios**:

1. **AS-58 (metrics and logs)** — **Given** the flows above, **Then** these metrics exist and move: `launch_queue_joins_total{result}`, `launch_queue_length{event}`, `launch_admitted_total`, `launch_admission_stale_leader_total`, `launch_holds_total{outcome}` (outcomes `created`, `seat_taken`, `limit`, `admission_refused`, `unavailable`), `launch_hold_degraded_total{store}`, `launch_confirms_total{outcome}`, `launch_double_booking_detected_total` (stays 0; a detector query runs with the reconciler), `launch_reconcile_repairs_total{kind}`; every log line carries `requestId`; no log line, metric label, span attribute, problem body or event contains an admission token, a ticket-to-user mapping, or an `Idempotency-Key`.
2. **AS-59 (problem+json contract)** — **When** any error in this capability occurs, **Then** the response is `application/problem+json` with `type, title, status, detail, instance, requestId` and a stable `code` from the vocabulary in FR-051; any `5xx` has a generic `detail`.
3. **AS-60 (jobs are idempotent and single-run)** — **Given** the jobs `launch-events.expire-hold`, `launch-events.open-sales`, `launch-events.close-event`, `launch-events.reconcile-seats`, **When** each is delivered twice, concurrently, and with an invalid payload, **Then** the effect happens once and the invalid payload is rejected without side effects; the reconciler running on two workers at once repairs each drift once.
4. **AS-61 (domain isolation)** — **Then** every query of this capability reads and writes only tables in `owned(launch-events)`; there is no foreign key, association or injected model of another owner (`Shop`, `ShopMembership`, `User`); `pnpm --dir packages/backend check:table-ownership --strict` reports no finding for the booking part; shop membership is checked through tenancy's exported guard and service (R1); the barrel exports modules and DTO types only (no model, no service class, no ticker).
5. **AS-62 (events carry the envelope)** — **Given** each emitted event, **Then** it has `eventId, type, version, occurredAt, aggregateId` and the documented payload, is written through the outbox in the same transaction as its state change, and is absent when that transaction rolls back.

### Edge Cases

- A buyer's session expires while waiting: the status call answers `401`; the ticket survives until its heartbeat lapses; after re-login the same buyer gets the same ticket on join (AS-02).
- A buyer holds seats, then their admission token expires: the hold stays valid and confirmable (AS-18, FR-016).
- Two buyers hold different seats at the same moment: neither blocks the other (AS-26, no waiting on locks).
- The clock of a worker differs from the clock of another: every time decision uses the server's injected clock at the deciding step, never the client's (`X-Client-Time` is ignored); hold times are compared with `expiresAt` as stored (AS-37).
- A seat is held by buyer A whose browser is closed: the hold expires by itself; nobody has to release it (AS-28).
- An organizer closes the event while buyers are mid-confirm: the confirm either committed before the close or answers `409 EVENT_CLOSED`; never a booking after a committed close (AS-54, FR-043).
- Seat counts at the limit (100,000 seats): the map is 12,500 bytes; hold requests stay ≤ 10 seats (AS-19, AS-45).
- A queue entry whose user was deleted: it is admitted like any other; the token's subject then fails nothing here; the hold step requires a valid session anyway.

## Requirements *(mandatory)*

### Functional Requirements

**Waiting room (P0323, P0619, P0326)**

- **FR-001**: A buyer MUST be able to join an event's queue while the event is `SCHEDULED` or `ON_SALE`; joining answers a ticket, position, queue length and estimated wait; joining touches only the queue store (AS-01, AS-09).
- **FR-002**: Joining MUST be idempotent per (event, buyer): the same ticket and position come back; concurrent joins create one ticket (AS-02).
- **FR-003**: Queue order MUST follow the scoring rule: pre-sale joins random within the first second after sales open, post-open joins by instant, pre-sale always ahead (AS-03).
- **FR-004**: The room MUST admit at most `admissionRatePerSec` buyers per second per event, in queue order within the position tolerance, with a one-second bucket capacity and no catch-up burst after downtime (AS-04, AS-06).
- **FR-005**: Exactly one admitter MUST act per event at a time across all workers; every admission write MUST carry a fencing epoch that a newer admitter invalidates, so a paused or stale admitter cannot admit (AS-08).
- **FR-006**: An admitted buyer MUST receive an admission token (signed, algorithm pinned, issuer `marketplace`, audience `admission:<eventId>`, subject = buyer, `jti` = ticket, purpose `admission`, 10-minute lifetime), through the status endpoint and one `admitted` push on `queue:<ticket>` (AS-05).
- **FR-007**: A ticket whose owner has not polled for 120 s MUST be skipped and removed without using admission capacity; polling refreshes it (AS-07).
- **FR-008**: Ticket status MUST be visible only to its owner; others and unknown tickets get the same `404 TICKET_NOT_FOUND`; the realtime topic `queue:<ticket>` MUST be subscribable only by the owner (AS-10, AS-50).
- **FR-009**: Position MUST be within 16 places of the true order, MUST NOT increase between polls once sales are open, and the estimate is `ceil(position ÷ rate)` (AS-06).
- **FR-010**: When the queue reaches its configured maximum length the room MUST shed new joins with `503 WAITING_ROOM_FULL` + `Retry-After`, serve existing ticket holders, and touch no other store; when the queue store is down it MUST answer `503 WAITING_ROOM_UNAVAILABLE` and touch no other store (AS-11).
- **FR-011**: Joins MUST be rate limited per user by policy `launch.queue.join.user` (fail open) (AS-12).
- **FR-012**: An event may require a bot-check result; verification MUST go through a port with a 2-second timeout, MUST fail closed on provider failure, and a result MUST be accepted once (AS-13, AS-14).

**Admission token and holds (P0311, P0326, P0414)**

- **FR-013**: The hold endpoint MUST verify the admission token (signature, algorithm, issuer, audience, subject, purpose, expiry) before any store is touched; any failure is `403 ADMISSION_REQUIRED` (AS-18).
- **FR-014**: A hold request MUST contain exactly one of `seats` (1–10 distinct non-negative integers, seated events only) or `quantity` (1–10, best-available); duplicates in `seats` are collapsed (AS-19).
- **FR-015**: Holds MUST be accepted only when the authoritative event status is `ON_SALE` (AS-20).
- **FR-016**: A hold MUST last exactly 10 minutes from creation by the server clock; confirm and release MUST NOT need the admission token (AS-15, AS-37).
- **FR-017**: At most one active hold MAY exist per seat. The guarantee MUST come from a conditional write in the durable hold ledger, with the fast lock store only as a first filter and no waiting on locks; an expired hold counts as free at the instant of the conditional write (AS-16, AS-28, AS-29).
- **FR-018**: Multi-seat holds MUST be all-or-nothing, and rollback MUST remove only records written by the same hold, verified by the hold ID and the per-seat fencing number (AS-17, AS-27).
- **FR-019**: Each seat record MUST carry a fencing number that increases with every new hold of that seat; confirm, release, expiry and rollback MUST be conditional on it (AS-27).
- **FR-020**: Best-available holds MUST assign disjoint seats under any concurrency without callers waiting on each other, prefer adjacent seats in one row, and fail whole with `409 NO_SEATS_AVAILABLE` when the quantity is not available (AS-26).
- **FR-021**: Hold creation MUST require `Idempotency-Key` with the semantics of constitution V.6: replay returns the stored status and body, an in-flight key `409`, a reused key with a different body `422`, a missing or invalid key `422`; keys live 24 hours and are scoped per user (AS-25).
- **FR-022**: Hold creation MUST be rate limited per user by `launch.hold.user` (fail closed → `503 HOLDS_UNAVAILABLE`) (AS-31).
- **FR-023**: If the durable ledger is unavailable, holding MUST fail with `503 HOLDS_UNAVAILABLE` and leave no effect; if the fast lock store is unavailable, holding MUST still be correct on the ledger alone and count a degradation (AS-29, AS-30).
- **FR-024**: Hold expiry MUST run at `expiresAt` through a scheduled job and MUST be safe to run late, twice or concurrently with confirm or release (AS-28, AS-36).
- **FR-025**: A user MUST be able to release their active hold; releasing a `RELEASED` or `EXPIRED` hold is a no-op `204`; releasing a `CONFIRMED` hold is `409 HOLD_ALREADY_CONFIRMED` (AS-37).

**Ticket limits (P0311)**

- **FR-026**: A buyer's seats held plus booked for one event MUST NOT exceed `perUserLimit` (1–10, default 2), including under concurrency (AS-21, AS-22).
- **FR-027**: Quota MUST be released exactly once per ended hold (release, expiry and rollback never double-credit) (AS-23).
- **FR-028**: The quota counter MUST NOT be the source of truth: a missing counter is rebuilt from bookings and active holds, every counter has an expiry, and confirm re-checks the limit against bookings in the booking transaction (AS-24).

**Booking confirm (P0304, P0311, P0110, P0414)**

- **FR-029**: Confirm MUST turn an active hold of the caller into `CONFIRMED` bookings (one row per seat) exactly once; the booking rows, one history row each, the `booking_confirmed` event and the voucher command MUST be written in one transaction without network calls inside it (AS-33, AS-42).
- **FR-030**: Confirm MUST require `Idempotency-Key` (V.6); a different key on an already confirmed hold of the same buyer returns `200` with the same bookings (AS-34, AS-35).
- **FR-031**: At most one `CONFIRMED` booking MAY exist per (event, seat); the store itself MUST refuse a second one, whatever the application did, and confirm answers `409 SEAT_TAKEN` without writing anything (AS-38).
- **FR-032**: Confirm MUST be mutually exclusive with expiry and takeover of the same hold: exactly one wins; a booking never exists on a seat that another hold has been given (AS-27, AS-36).
- **FR-033**: Hold and event state changes MUST follow the state machines of FR-043 / AS-56 through conditional updates that assert one affected row; illegal transitions answer the codes in FR-051 (AS-37, AS-56).
- **FR-034**: When the last seat is booked the event MUST become `SOLD_OUT` once, emit `event_sold_out` once and refuse new holds (AS-43).
- **FR-035**: After a confirmed booking the capability MUST send the voucher command `orders.booking_voucher_requested` v1 once per hold with dedupe key `booking-voucher:<holdId>`; a missing or failing consumer MUST NOT affect the booking (AS-44).
- **FR-036**: A reconciler MUST run every 60 s per event with open holds or recent bookings, repairing ledger, seat map and bookings drift (booking without ledger confirmation, ledger confirmation without booking after 120 s, stray map bits), and MUST run a double-booking detector (AS-41, AS-48, AS-58).
- **FR-037**: A buyer MUST be able to list their own bookings for an event (AS-57).

**Seat map (P0323)**

- **FR-038**: The seat map MUST be a 1-bit-per-seat bitmap (bit order fixed by AS-45) with a `seq`, served anonymously with `Cache-Control: public, s-maxage=1` and limited per address by `launch.seatmap.ip` (fail open) (AS-45, AS-49).
- **FR-039**: Every seat change (`held`, `booked`, `released`) MUST be published as a delta with a strictly increasing `seq` assigned atomically with the bitmap change; clients apply only `last + 1`, ignore `seq ≤ last` and refetch on a gap (AS-46, AS-47).
- **FR-040**: The seat map MUST be rebuildable from authoritative state, rebuilt behind a single flight when lost, and every map key MUST expire; the map is never consulted for a hold or confirm decision (AS-48).

**Events and organizer (P0110, P0311)**

- **FR-041**: Shop members with `products.write` MUST be able to create events with the validated shape of AS-51/AS-52; the response is a DTO; `shopId` has no database foreign key (AS-51, AS-52, AS-61).
- **FR-042**: Shop members with `orders.manage` MUST be able to list an event's bookings with keyset pagination (`limit` ≤ 100, default 50, opaque cursor, order `confirmedAt DESC, bookingId DESC`), scoped by shop in the query (AS-53).
- **FR-043**: Event status MUST move only along `SCHEDULED→ON_SALE` (at `salesOpenAt`), `ON_SALE→SOLD_OUT`, and `→CLOSED` (organizer close or at `startsAt`); closing refuses new joins and holds, makes active holds unconfirmable and frees their seats within 60 s (AS-54, AS-55, AS-56).
- **FR-044**: The public event page MUST be cacheable, hold only public fields, and be invalidated on every status change (AS-49, AS-55).
- **FR-045**: Every record lookup in this capability MUST carry the principal in the predicate (shop for organizer routes, buyer for holds, bookings and tickets) and answer `404` for anything not theirs (AS-10, AS-39, AS-53, AS-57).

**Operations (VIII, V, IV)**

- **FR-046**: The capability MUST emit the events `launch_events.event_created`, `launch_events.booking_confirmed`, `launch_events.event_sold_out`, `launch_events.event_closed` through the outbox (AS-62).
- **FR-047**: Metrics, logs and redaction MUST follow AS-58; time decisions use an injected clock.
- **FR-048**: Jobs MUST be idempotent and single-run (AS-60).
- **FR-049**: Every request/response MUST have a schema in `packages/contracts` (see Cross-capability contracts) and every error MUST be problem+json (AS-59).
- **FR-050**: Realtime topics `queue:<ticket>` (owner only) and `event:<eventId>:seatmap` (public) MUST be defined by this domain's topic module (AS-50).
- **FR-051**: Error `code` vocabulary (the codes are stable): `ADMISSION_REQUIRED` 403, `HUMAN_CHECK_FAILED` 403, `EVENT_NOT_FOUND` 404, `TICKET_NOT_FOUND` 404, `HOLD_NOT_FOUND` 404, `EVENT_NOT_ON_SALE` 409, `EVENT_SOLD_OUT` 409, `EVENT_CLOSED` 409, `EVENT_ALREADY_CLOSED` 409, `SEAT_TAKEN` 409 `{seat?}`, `NO_SEATS_AVAILABLE` 409, `HOLD_EXPIRED` 409, `HOLD_RELEASED` 409, `HOLD_ALREADY_CONFIRMED` 409, `UNKNOWN_SEAT` 422 `{seat}`, `SEATS_NOT_SELECTABLE` 422, `TICKET_LIMIT_EXCEEDED` 422 `{limit, remaining}`, `invalid_schedule` 422, `WAITING_ROOM_FULL` 503, `WAITING_ROOM_UNAVAILABLE` 503, `HOLDS_UNAVAILABLE` 503; shared codes `validation_failed`, `permission_denied`, `idempotency_in_flight`, `idempotency_key_reuse`, `idempotency_key_required`, `idempotency_key_invalid`, rate-limit `429` come from the platform toolkit (S54).

### Key Entities

- **Launch event**: a brand's seated or general-admission event with title, venue, start time, sales-open time, seat count, seats per row, seating mode, per-person limit, admission rate, bot-check flag, status (`SCHEDULED`, `ON_SALE`, `SOLD_OUT`, `CLOSED`), owned by one shop (a plain shop ID).
- **Queue ticket**: one buyer's place in an event's waiting room: score, heartbeat, admitted state, token expiry. Short-lived, in the queue store only.
- **Admission token**: a signed, 10-minute proof that a ticket was admitted, bound to event and buyer.
- **Hold**: a buyer's 10-minute claim on one or more seats (`HELD`, `CONFIRMED`, `RELEASED`, `EXPIRED`) with its seat records (fencing numbers) in the durable hold ledger.
- **Booking**: a confirmed seat for a buyer; one row per seat; at most one `CONFIRMED` per (event, seat); with a history row per state change.
- **Seat map**: a 1-bit-per-seat display picture of taken seats with a change sequence number; derived, expiring, rebuildable.
- **Quota counter**: derived count of a buyer's held plus booked seats per event; expiring, rebuildable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Across any load, concurrency or failure test, the number of seats with more than one confirmed booking is exactly 0 (checked by a query after every e2e run and by the detector metric).
- **SC-002**: When 100 buyers pick the same seat at once, exactly 1 gets it and the other 99 get a clear "seat taken" answer, every time (repeated 20 runs).
- **SC-003**: The room admits no more than the configured rate in any one-second window, including after a worker restart or a paused leader.
- **SC-004**: At a spike of 20,000 concurrent buyers, joining the queue answers within 100 ms for 99% of requests, holding a seat within 150 ms for 99%, and reading the seat map within 50 ms for 99%; the relational database sees no queue, hold or seat-map traffic, only confirmations (at most one booking per seat).
- **SC-005**: A buyer who confirms twice, retries a timed-out request, or double-clicks ends with exactly one booking per seat, 100% of the time.
- **SC-006**: A buyer never holds or books more seats for one event than the event's limit, even with parallel requests or after a cache wipe.
- **SC-007**: A held seat that is not confirmed is bookable by someone else at most 1 second after the 10 minutes end, even when background jobs are down.
- **SC-008**: After the fast stores are wiped, the seat map and quota are correct again within 60 seconds without operator action.
- **SC-009**: A buyer's place in line never gets worse after sales open, and the displayed wait is within a factor of 1.5 of the actual wait for 90% of buyers in a steady-rate run.
- **SC-010**: No admission token, ticket or idempotency key appears in any log line, metric or event of a full flow run.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `S22` and `launch-events`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S11 (flash sales)**: admission is its own; S22's waiting room is not a dependency, and a verifier of a signed admission token may later sit in front of S11's `admit` without changing its contract (honoured: the token is audience-scoped to `admission:<eventId>`; S11 would need its own audience, not reuse this one; see `questions.md` [CONTRACT]).
- **S21 (limited drops)**: names S22 only for queue-based launches; no contract.
- **S01**: issuer string `marketplace` for admission tokens and the e2e fixture `issueTokensFor` replacement (honoured: FR-006; the e2e specs use the identity fixture).
- **S03**: `ShopAccessService.assertMember` replaces `ShopMembership` reads in launch-events; that concerns S23 (live) and is not used by S22 (this capability uses `ShopScoped` only) — honoured for S22.
- **S23 (same domain)**: S22 exports nothing to S23 and S23 must not import S22 internals.
- **J03 (journey, not written)**: will consume `launch_events.booking_confirmed`, the seat map and the queue endpoints below.

**Provides** (exact names; HTTP under `/api`; problem+json errors with `code`; schemas in `packages/contracts`; modules exported from `@app/domains/launch-events`):

- HTTP (schemas: `launchEventSchema`, `createLaunchEventRequestSchema`, `queueStatusSchema`, `holdSeatsRequestSchema`, `holdSchema`, `confirmResponseSchema`, `bookingSchema`, `bookingPageSchema` = `{items, nextCursor}`, `seatMapSchema`, `seatMapDeltaSchema`):
  - `POST /shops/:shopId/launch-events` (`ShopScoped('products.write')`) → `201 launchEventSchema` `{id, shopId, title, venue, startsAt, salesOpenAt, seatCount, seatsPerRow, seatingMode, perUserLimit, humanCheckRequired, status}`.
  - `POST /shops/:shopId/launch-events/:eventId/close` (`products.write`) → `200 launchEventSchema`.
  - `GET /shops/:shopId/launch-events/:eventId/bookings?limit&cursor` (`orders.manage`) → `bookingPageSchema` of `{bookingId, holdId, seat, userId, confirmedAt}`.
  - `GET /launch-events/:eventId` (anonymous, `s-maxage=60`) → `launchEventSchema`.
  - `POST /launch-events/:eventId/queue` (session; optional `X-Human-Check`) → `201 | 200 queueStatusSchema` `{ticket, admitted, position?, queueLength?, etaSeconds?, heartbeatSeconds, expiresAt, admissionToken?, tokenExpiresAt?}`.
  - `GET /launch-events/:eventId/queue/:ticket` (session, owner) → `200 queueStatusSchema`.
  - `POST /launch-events/:eventId/holds` (session; `X-Admission-Token`; `Idempotency-Key`; body `holdSeatsRequestSchema` = `{seats: number[]} | {quantity: number}`) → `201 holdSchema` `{holdId, eventId, seats, expiresAt, serverTime, limit: {perUser, remaining}}`.
  - `POST /launch-holds/:holdId/confirm` (session; `Idempotency-Key`) → `201 | 200 confirmResponseSchema` `{holdId, eventId, bookings: [{bookingId, seat}], confirmedAt}`.
  - `DELETE /launch-holds/:holdId` (session) → `204`.
  - `GET /launch-events/:eventId/seatmap` (anonymous, `s-maxage=1`) → `seatMapSchema` `{eventId, seatCount, seatsPerRow, seq, bitmap}`.
  - `GET /launch-events/:eventId/my-bookings` (session) → `{items: [{bookingId, seat, confirmedAt}]}`.
- Realtime topics (registered by `LaunchEventTopicsModule`): `queue:<ticket>` event `admitted` `{eventId, admissionToken, tokenExpiresAt}` (owner only); `event:<eventId>:seatmap` event `seats` = `seatMapDeltaSchema` `{seq, change: 'held' | 'booked' | 'released', seats: number[]}` (public).
- Events (outbox → Kafka topic `launch-events.events`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`):
  - `launch_events.event_created` `{launchEventId, shopId, title, startsAt, salesOpenAt, seatCount}` (key `launchEventId`).
  - `launch_events.booking_confirmed` `{holdId, launchEventId, shopId, userId, seats: number[], bookingIds: string[], confirmedAt}` (key `holdId`). **Consumers: S28 (confirmation notice), J03.**
  - `launch_events.event_sold_out` `{launchEventId, shopId}`; `launch_events.event_closed` `{launchEventId, shopId, reason: 'organizer' | 'started'}` (key `launchEventId`).
- Single-consumer command (SQS): `orders.booking_voucher_requested` v1 `{holdId, bookingIds: string[], launchEventId, shopId, userId, seatCount}`. **Consumer: S10 (asked; see `questions.md`).**
- Rate-limit policies (declared in S50's registry): `launch.queue.join.user` 10/minute per user (fail open); `launch.hold.user` 30/minute per user (fail closed); `launch.seatmap.ip` 600/minute per address (fail open).
- Jobs (registered with S49): `launch-events.expire-hold` (per hold, `runAt = expiresAt`), `launch-events.open-sales` (per event, `runAt = salesOpenAt`), `launch-events.close-event` (per event, `runAt = startsAt`, also used for organizer close fan-out), `launch-events.reconcile-seats` (every 60 s, concurrency 1).
- Modules for the apps: `LaunchEventsModule` (core: HTTP), `LaunchEventsWorkerModule` (worker: jobs, admitter), `LaunchEventTopicsModule` (sse-gateway). Nothing else is exported: no model, repository, ticker, or service class.

**Requires**:

- **S01** (`identity`): `Firewall({ anonymous? })`, `@User()` → `AuthenticatedUser = { id, role, sessionId, amr }`; and — **asked, not in S01's Provides today** — an R1 `PurposeTokenService`: `sign({ subject: UserId, audience: string, ttlSec: number, jti?: string, claims?: Record<string, string | number> }): Promise<string>` and `verify(token: string, expected: { audience: string; subject?: UserId }): Promise<{ subject: UserId; jti: string | null; expiresAt: Date; claims: Record<string, unknown> }>` throwing `InvalidPurposeTokenError` for any signature, algorithm, issuer, audience, subject or expiry failure; ES256 via the JWKS key set, `iss: marketplace`, never accepted as an access token (S01 FR-027).
- **S03** (`tenancy`): `ShopScoped(permission)` with the shop-status gate; permissions `products.write` (OWNER, ADMIN, STAFF) and `orders.manage` (OWNER, ADMIN, STAFF); a non-member answers `404`. This capability reads no tenancy data otherwise (the shop ID is a plain ID, no FK; R1 only through the guard).
- **S49** (job scheduler): `JobsService.enqueue(type, payload, { runAt, idempotencyKey })` single-run, with idempotent handlers; recurring registration for `launch-events.reconcile-seats`.
- **S50** (rate limiter): the three policies above by name, with `Retry-After`.
- **S51** (realtime hub): `TopicRegistry.define({ prefix, suffixes?, policy })` where `policy` is async and receives the authenticated principal (needed for the owner-only `queue:` topic), and `RealtimePublisher.publish(topic, event, payload)`.
- **S52** (cache toolkit): cache-aside with single flight and negative caching for the event page; invalidation on status change.
- **S53** (events/outbox): `outbox.append(event)` inside the domain's own transaction (IX.6); relay to topic `launch-events.events`; single-consumer command delivery for the voucher command.
- **S54** (platform toolkit): global problem+json filter with `code` and `requestId`; the shared `Idempotency-Key` facility with V.6 semantics and its `idempotency_*` codes; request context and `@Transactional`; config validation at startup (queue maximum length, human-check provider); metrics registry; graceful shutdown that stops the admitter first.
- **S10** (`orders`): consumes `orders.booking_voucher_requested` v1 (idempotent on `booking-voucher:<holdId>`), turning it into the pre-order voucher; **not in S10's Provides today**; S22 does not depend on its success.
- **S28** (`notifications`): consumes `launch_events.booking_confirmed`.
- External: a bot-check provider reached only through a domain port and an `infra/` adapter (IV.8), response validated; the durable hold ledger, the fast queue/seat-map/quota store, and the relational database as stores this domain owns (domain map: "Other stores").

Cross-domain data used by S22 (constitution IX.7): **R1** — tenancy's `ShopScoped` guard and identity's `PurposeTokenService`; no R2 (this capability has no composed screen; a future BFF may compose the event page, seat map and shop summary through `GET /api/launch-events/:eventId` and `GET /api/batch/shops`); **R3** — none (no cross-domain filtering or sorting needed; the organizer's booking list is a table this domain owns).

## Assumptions

- A seat is not priced; booking is free and the pre-order voucher is a separate async concern (S10). If a product decision later requires paying for the seat, hold→payment→confirm becomes a saga in `payments`/`orders` and this spec changes.
- Seats are numbered `0 … seatCount − 1`; a seat label (row/seat) is derived for display by the client from `seatsPerRow`.
- One event serves at most 100,000 seats and at most one booking tier. Sharded-queue fan-out and the reported position tolerance (16 places) are accepted trade-offs of the queue's throughput design.
- The queue-length maximum, the bot-check provider and its timeout are configuration validated at startup; the default maximum is 2,000,000 tickets per event.
- Heartbeat is the ticket status poll (≥ once per 120 s); realtime clients also poll at that cadence. Position and wait estimates are polled, not pushed; only admission is pushed.
- Booking status `CANCELLED` exists in the table but no route in this capability reaches it (no cancellation, no refunds here).
- Closing at `startsAt` is automatic; an organizer may close earlier. No reopen, no seat-count change after creation, no event edit in this capability.
- "Verified account" gating and device fingerprinting are not offered; abuse is limited by sessions, the per-person limit, rate limits, the bot-check hook and queue fairness.
- Real engines of the production kinds are used in tests (see `test-plan.md`); the clock is frozen and advanced; only the identity provider verification, the bot-check provider, the realtime transport (where forced to fail), and S10's consumption are faked at the edge.
- The 10-minute hold and 10-minute admission token are constants of this capability, not event settings.
- Pattern coverage (pattern-map rows naming S22): P0110 → AS-37, AS-56 (event and hold state machines, exhaustive); P0304 → AS-38 (one confirmed booking per seat, enforced by the store); P0311 → AS-16, AS-21, AS-22, AS-36, AS-43, AS-55 (conditional updates, no check-then-write); P0312 → AS-26, AS-60 (best-available without waiting on locks; single-run jobs); P0323 → AS-01, AS-45, AS-46, AS-48 (ordered queue, 1-bit-per-seat map); P0326 → AS-08, AS-17, AS-27 (single admitter with fencing epoch, per-seat fencing numbers); P0414 → AS-25, AS-34, AS-35 (idempotency keys); P0619 → AS-04, AS-11, AS-12 (admission control and load shedding).
- Defaults for every unanswered choice are recorded in [`questions.md`](questions.md).
