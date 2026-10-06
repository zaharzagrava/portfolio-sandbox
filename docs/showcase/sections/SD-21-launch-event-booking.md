# SD-21 — Launch Event Booking (Ticketmaster → "iPhone launch event seats")

Status: ☑ done (typechecked; spec + k6 written, not run) · Phase 2 · Depends on: F-03, F-05, SD-28, SD-29 · Reuses SD-19 waiting room for flash sales

## Marketplace adaptation
Brands host **launch events** ("iPhone 18 Keynote Live — Berlin flagship store, 800 seats", "Galaxy Unpacked watch party"). Seats are specific (row/seat) or general admission tiers. Sales open at a fixed time; **millions** try in the first minutes. Booking includes a launch-day pre-order voucher → ties into checkout/payments.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Virtual waiting room**: join → position in a Redis sorted set (randomised for pre-sale arrivals) → admission at a token-bucket rate the booking tier can handle → **signed admission token** (JWT, short TTL, eventId-scoped) checked by booking API | 10/07 #21, 06/03 §5 admission control |
| Queue position + ETA pushed over SSE (F-03), heartbeat to keep the spot | 10/06 |
| **Seat hold**: Redis `SET seat:{eventId}:{seatId} holdId NX PX 600000` as fast lock + durable hold record; exactly one winner | 03/04 §6, 10/07 #21 |
| Holds durable in **DynamoDB** (`Holds` table, conditional put `attribute_not_exists(seatId) OR expiresAt < :now`) — authoritative hold ledger without Postgres row locks | D24 |
| Postgres: booking confirmation (money involved) with conditional transition HELD → BOOKED; `UNIQUE(eventId, seatId) WHERE status='BOOKED'` partial index as final guard | 03/01 §3.3 partial index |
| **Best-available** for GA tiers: Redis list of free seat IDs `LPOP` (or Postgres `FOR UPDATE SKIP LOCKED` in the DB-only variant, documented) | 03/02 §5 |
| Hold expiry via TTL + SD-29 job releasing Dynamo/Postgres state | 10/07 #21 |
| **Seat map read model**: bitmap per event in Redis (`SETBIT`, 1 bit/seat → 800 seats = 100 bytes) served from CDN-cacheable endpoint (1 s TTL) + delta events over SSE | 10/07 #21 |
| Per-user ticket limits (Redis counter per user/event) + bot protection hook (Turnstile token verify at edge) | 10/07 #21 |
| Load shedding at the room entrance (F-01) | 06/03 §5 |

## Data / storage
- Postgres: `LaunchEvent`, `EventSeat` (static layout), `Booking`, `BookingEvent`.
- DynamoDB: `Holds` (PK `EVENT#<eventId>`, SK `SEAT#<seatId>`, TTL).
- Redis: `wr:{eventId}` ZSET (queue), `wr:{eventId}:admitted` rate state, `seatmap:{eventId}` bitmap, `seat:{eventId}:{seatId}` locks.

## API
`POST /events/:id/queue` → position; `GET /streams?topics=queue:{ticket}` (SSE); `POST /events/:id/holds` (admission token) → holdId; `POST /holds/:id/confirm` (Idempotency-Key) → booking; `GET /events/:id/seatmap`.

## Steps
- [x] Models + migrations; Dynamo `Holds` table def.
- [x] Waiting room service (enqueue, admission ticker job every 1 s admitting N = rate, JWT admission token).
- [x] Hold service (Redis NX + Dynamo conditional put; rollback Redis on Dynamo failure), confirm (Postgres booking + payment voucher via SD-19 checkout), release/expire.
- [x] Seat map bitmap + SSE deltas.
- [x] e2e: 100 parallel holds on one seat → 1 success, 99 × 409 `SEAT_TAKEN`; hold expiry → seat bookable again; admission token for other event → 403.
- [x] k6 `loadtest:launch-event` (on-sale spike: 0 → 20k VUs in 30 s).

## Scale
- Target: 1M arrivals in 5 min (~3.3k joins/s, bursts 50k/s), booking tier admits 2k users/s, seat map 100k RPS.
- Hot path: join → Redis ZADD (no DB). Seat map → CDN (1 s) → Redis GETRANGE. Hold → Redis SET NX + 1 Dynamo conditional write. Only confirmations touch Postgres (≤ seats count total).
- First bottleneck & fix: the waiting room ZSET for a mega-event is one hot key → shard the queue into K sub-queues by hash(userId) with interleaved admission; seat-map reads → CDN collapse.
- Capacity model: Redis ~100k ZADD/s per shard → 1 shard per mega-event queue (sharded to 4 for headroom); Dynamo on-demand absorbs 2k writes/s trivially.
- Proof: k6 spike, thresholds: join p99 < 100 ms, hold p99 < 150 ms, double-booked seats == 0.

## FE visualisation (phase 2)
Waiting-room screen with live position, interactive seat map, hold countdown.

## Implementation notes (2026-10-01)
- Migration `20261001170000-launch-events`: `LaunchEvent`, `Booking` with partial unique index (one CONFIRMED per seat) + unique (holdId, seat) for idempotent confirms. DynamoDB `Holds` table (`dynamodb/Holds.json` documents keys/access patterns).
- `libs/common/src/launch-events/`: `WaitingRoomService` (8 sharded ZSETs per event, randomized pre-sale arrival order, ticket→user binding, admission JWT `aud=admission:<eventId>` via KeyStore, SSE push on `queue:<ticket>` + polling fallback), `AdmissionTicker` (1 s ticks, Redis leader lease → rate is per event not per worker; hosts `launch-events.expire-hold`), `SeatHoldService` (Redis `SET NX PX` filter → DynamoDB conditional put with explicit expiry check (TTL is lazy) → Postgres only on confirm; all-or-nothing multi-seat with compare-and-delete rollback; per-person limit; 1-bit-per-seat Redis bitmap + SSE deltas), `LaunchEventsController` (create, cached event page, join/status, seat map with `s-maxage=1`, holds, confirm, release).
- `TopicPolicies`: `queue:` topics allowed by capability (unguessable ticket).
- Spec `launch-events/launch-events.e2e-spec.ts`; k6 `launch-event.test.js` (`pnpm loadtest:launch-event`, 0→20k VUs spike).
