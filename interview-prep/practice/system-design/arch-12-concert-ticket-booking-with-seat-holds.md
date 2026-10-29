# arch-12. Concert ticket booking with seat holds

*Commerce · Medium*

## The question

"Design ticket sales for big concerts. A 50,000-seat stadium show goes on sale at 10:00 and ~1M fans show up. Users pick seats on a seat map (or 'best available'), get an 8-minute hold while paying, max 6 tickets per account. No seat may be sold twice, and the site must stay up."

**Then:** "The payment provider gets slow (p99 20 s), so holds expire while people are paying. And everyone is fighting for the same front sections."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Fairness model? → assume: a virtual waiting room; people who arrive before 10:00 get a random position, later arrivals queue in order.
- Resale/transfer? → assume: out of scope.
- Bots? → assume: a real concern; one queue position per verified account, CAPTCHA at queue entry.
- Payment? → assume: card via PSP with 3DS where required; idempotent payment creation.
- Numbers, without a queue → assume: 1M users refreshing the seat map every few seconds ≈ several hundred thousand req/s against the booking system. Impossible to serve cheaply, and pointless for 50k seats.
- Numbers, with a queue → assume: admit ~3k users/min; with ~8-10 min per shopper that's ~25-30k active shoppers, ~200-500 hold attempts/s. Postgres handles that easily on distinct rows. Seat inventory: 50k rows per event.

## Design

**1. Waiting room.** Static queue page on the CDN. Joining = one call to the queue service (Redis): position assigned (random for pre-10:00 arrivals, `INCR` afterwards). The page polls every ~15 s for position and estimated wait. An admitter releases users at a rate set from booking-system health and remaining inventory, issuing an **admission token** (signed JWT: `event_id`, `user_id`, `exp` 15 min). Every booking API call requires it. When seats are gone, the queue is told immediately.

**2. Seat map reads.** Availability is a bitmap: 50,000 seats = 6.25 KB uncompressed. A job snapshots it every 1-2 s to S3/CDN (`max-age=2`). The map is a hint, not a promise; the hold call decides.

**3. Holds** (Postgres, all-or-nothing per request):
```sql
seats(event_id, seat_id, section, row, num, price_tier, status, hold_id, hold_expires_at, order_id,
      PRIMARY KEY (event_id, seat_id))

UPDATE seats SET status = 'held', hold_id = $hold, hold_expires_at = now() + interval '8 minutes'
WHERE event_id = $e AND seat_id = ANY($seats)
  AND (status = 'available' OR (status = 'held' AND hold_expires_at < now()))
RETURNING seat_id;
-- fewer rows than requested → ROLLBACK, return "taken" with nearby alternatives
```
Expired holds count as available in the WHERE, so expiry needs no timer to be correct; a sweeper resets them every 30 s so the map is accurate. Per-account limit: `holds(hold_id, user_id, event_id, seat_count)` with a check on the sum of active holds + orders ≤ 6 in the same transaction.

**4. Best available.** The booking service keeps per-section availability in memory (from the bitmap), picks a contiguous block in the best section, attempts the UPDATE, and tries the next block on conflict.

**5. Checkout.** `POST /orders {holdId}` (idempotency key) → order `pending_payment`, hold becomes `paying` (no longer expirable by time) → PSP → on success, `UPDATE seats SET status = 'sold', order_id = $o WHERE hold_id = $hold`, tickets issued via outbox.

## Deep dives

**1. Contention.** Row-level contention is on seats, not a counter: two users clicking the same seat both run the UPDATE; under READ COMMITTED the second waits for the first's commit, re-checks the WHERE on the new row version, and updates 0 rows. Transactions are milliseconds, so waits are short. Chosen: conditional UPDATE, short transactions, and the queue keeping attempt rate in the hundreds per second. Rejected: `SELECT … FOR UPDATE` then UPDATE in app code with network round trips in between (longer locks); Redis-only holds (fast, but then Redis is the inventory truth and a failover loses holds and sells twice).

**2. Holds expiring during slow payments (twist, part 1).** Chosen: when the user submits payment, the hold moves to `paying` with a longer safety expiry (15 min) and is excluded from time-based release. It ends only when the PSP result arrives (webhook or status query). A sweeper checks `paying` holds older than 15 min with the PSP by our payment ID before releasing. Rejected: a fixed 8-minute timer during payment (seat resold while the first buyer is charged → refund and an angry fan).

**3. Hot sections (twist, part 2).** Everyone wants the floor. Conflicts are fast failures, not load problems, but UX suffers: users click seats that are already gone on a 2-s-old map. Chosen: "best available in section X" as the default action (server picks seats it knows are free, retries internally), seat-level picking as an option; the queue admission rate is lowered when the conflict rate rises. Rejected: locking a whole section per user.

**4. The queue is the capacity control.** The booking system's limit is known from load tests; the admitter never exceeds it. A queue that admits by a fixed number ignores that holds are taking longer under PSP slowness: admission should follow the measured checkout rate.

## Traps

- Letting 1M users hit the booking API directly and relying on autoscaling: the database is the limit, not the web tier.
- Holding seats in a cache only: a cache failover sells seats twice.
- Releasing holds on a timer while the payment is in flight.
- A global inventory counter row per event: every request serializes on one row even though seats are independent.
- Treating the seat map as authoritative: it's a snapshot; the conditional UPDATE decides.
- Queue tokens that aren't signed or bound to an account: bots buy and share them.

## Say it (60–90 s)

With a million fans for fifty thousand seats, the first component is a virtual waiting room. Fans join a queue served from the CDN, early arrivals get random positions, and an admitter lets people through at the rate the booking system can handle, with a signed admission token bound to their account. The seat map is a bitmap snapshot of availability, six kilobytes for the whole stadium, published to the CDN every two seconds; it's a hint. The real decision is one conditional UPDATE in Postgres that sets seats to held only if they're available or their hold has expired, all or nothing. Expired holds count as available in that condition, so correctness doesn't depend on a timer; a sweeper just tidies up for the map. Checkout creates an order with an idempotency key. When payment starts, the hold moves to a paying state that the timer can't release, so a slow provider never causes the same seat to be sold twice; only the payment result ends it, and stale ones are checked with the provider first. For hot sections, I default to best-available picked by the server, and lower the admission rate when conflicts rise.

## Follow-ups

**Q:** How do you size the admission rate?
**A:** Load-test the hold + checkout path to find the sustainable rate, then let the admitter adjust by measured p99 latency, error rate and checkout completion, within a max.

**Q:** What if Redis (the queue) fails?
**A:** Positions are in Redis with AOF and a replica; tokens already issued stay valid because they're signed JWTs verified without Redis. Worst case, the queue page pauses admission for a minute.

**Q:** How do you stop scalpers?
**A:** Verified accounts (phone), CAPTCHA at queue entry, one position per account, per-card and per-address limits, and name-bound or rotating-barcode mobile tickets that are hard to resell.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
