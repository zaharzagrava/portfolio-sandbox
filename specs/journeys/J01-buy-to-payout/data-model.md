# Data Model: J01 — Buy to Payout

J01 owns no business entity. It adds **control-plane state** and **test-kit types**. Business entities (order, payment, journal, payout, statement, notification) are owned by S10, S13, S14, S15, S16, S28 and are only read here through public APIs.

## Control-plane state

| Name | Store | Fields | Lifetime / rules |
|---|---|---|---|
| Consumer pause flag | Redis key `consumer:pause:<group>` (shared by all processes) | `pausedAt` ISO, `by` admin id | No TTL by design (a pause must persist); cleared by `resume`; `GET` reports `state`. Documented keyspace (L-011). |
| Consumer lag | derived | `lag` = Σ(end offset − committed offset) over the group's partitions | read-only |
| Replay request | Kafka consumer-group offsets | `since` ISO → offsets-for-times seek | executed while the group is paused; then resumed; idempotent consumers absorb the repeats |
| Clock offset | Redis key `clock:offsetSeconds` | integer seconds ≥ 0 | present only when `CLOCK_CONTROL=enabled`; `PUT {mode:"real"}` deletes it; forward only |
| Admin job request | existing job table (S49) | `type` (allow-list), `payload`, `idempotencyKey`, status `QUEUED|RUNNING|SUCCEEDED|FAILED|DEAD`, `attempts`, `finishedAt` | no new table; idempotency by (admin, key) per V.6 |

No migration is required. If the job table lacks a unique (type, idempotencyKey) constraint, a single expand-only migration adds it with `lock_timeout` (III.11) — confirmed in task 1 of WP1.

## Journey kit types (test code only)

- `Actor { id, email, cookies }`.
- `Hop = 'H1'…'H13'` → `{ maxMs, owner }`; deadline = `2 × maxMs × JOURNEY_TIME_FACTOR`.
- `SellerFixture { owner: Actor, staff: Actor, shopId, productIds, destinationId }`.
- `Recorded { order, payment, balances, payouts, inboxCounts, statement }` — snapshot used by AS-24/25 to compare "identical observables".

## State transitions the journey asserts (owned elsewhere)

- Order: `RESERVED → PAID` (once, version +1) or `→ CANCELLED(payment_failed | user_cancelled | hold_expired)`; never `CANCELLED → PAID`.
- Payment: `PENDING → COMPLETED | FAILED`; `COMPLETED → REFUNDED`.
- Payout: `PENDING → IN_TRANSIT → PAID | FAILED` (`CANCELLED` exists).
- Period: `OPEN → CLOSING → CLOSED`.

## Boundary check (post-design)

Commission pricing crosses payments → statements through the exported `CommissionRateQueryService` only (R1). Consumer admin touches no domain table. The journey reads no table, topic or queue.
