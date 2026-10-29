# arch-13. Flash sale: checkout and inventory without overselling

*Commerce · Hard*

## The question

"Our e-commerce site runs a sneaker drop: 10,000 pairs across 12 sizes go on sale at 10:00:00, one pair per customer, and ~1M users are waiting. We expect ~50k 'buy' requests per second in the first seconds. Reserved pairs must be paid within 10 minutes. We must never sell more than 10,000, and the rest of the store must keep working."

**Then:** "The Redis primary fails over 20 seconds into the sale. And 15% of reservations are never paid; what happens to those pairs?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Raffle instead of first-come? → assume: first-come (the business wants it); a raffle would remove the contention problem and I'd mention it.
- Payment method? → assume: users must have a saved card + address before the sale; checkout is one tap.
- Per-customer limit across sizes? → assume: one pair total per account (and per card/address for bots).
- Where's the inventory truth? → assume: Postgres. Redis is a gate in front of it.
- Numbers → assume: 50k req/s for ~10 s, then a long tail of "sold out" views. Only ~10k requests can succeed, so 98% of the traffic must be answered cheaply. Payments: ~10k in 10 min ≈ 17/s.
- Isolation → assume: the sale runs on its own service and Redis, separate from normal checkout capacity.

## Design

**1. Before the sale.** Product page static on CDN; the "buy" button unlocks at 10:00 from a CDN-cached config (`max-age=1`). Stock per size loaded into Redis: `stock:{sale42}:size10 = 800`. A `soldout:{sale42}` flag is also published to the CDN as JSON.

**2. Gate (Redis, one Lua script, all keys hash-tagged `{sale42}` so they live in one slot):**
```lua
-- KEYS: stock key for the size, buyers set, reservations stream
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return {'dup'} end
local left = tonumber(redis.call('GET', KEYS[1]))
if left <= 0 then return {'soldout'} end
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
local id = redis.call('XADD', KEYS[3], '*', 'user', ARGV[1], 'size', ARGV[2])
return {'ok', id}
```
One shard runs tens of thousands of short scripts per second; requests beyond its capacity are shed with 503 + retry hint by the API tier (rate-limited per user).

**3. Confirm in Postgres** (a consumer of the stream, ~10k total writes):
```sql
inventory(sale_id, size, remaining int CHECK (remaining >= 0), PRIMARY KEY (sale_id, size))
reservations(id, sale_id, user_id, size, status, expires_at, UNIQUE (sale_id, user_id))

BEGIN;
UPDATE inventory SET remaining = remaining - 1
  WHERE sale_id = $s AND size = $z AND remaining > 0;   -- 0 rows → sold out
INSERT INTO reservations (...) VALUES (..., 'reserved', now() + interval '10 minutes');
COMMIT;
```
The client shows "securing your pair…" and polls `GET /reservations/me` (~1-2 s) until Postgres confirms.

**4. Order state machine:** `reserved → payment_pending → paid → fulfilled`; `reserved | payment_pending → expired` (timeout, or payment failed after retries) → stock returned. Payment with an idempotency key = reservation ID.

**5. Release.** An expiry job (every 30 s): `UPDATE reservations SET status = 'expired' WHERE status = 'reserved' AND expires_at < now()`, `UPDATE inventory SET remaining = remaining + 1`, then offer the pair to the waitlist (deep dive 3).

**6. Protecting the store.** Separate service, Redis and connection pool; per-user rate limits; once sold out, the CDN flag stops requests before they reach us.

## Deep dives

**1. Why not just Postgres?** `UPDATE … SET remaining = remaining - 1` on one row per size serializes on its row lock: each transaction holds it until commit (~1 ms with fsync), so ~1k/s per row at best, while 50k/s arrive. Chosen: Redis as an atomic gate that lets roughly `stock` requests through; Postgres only sees ~10k writes, so the hot row is fine. Rejected: Postgres alone (lock queue, connection pool exhaustion, the whole store slows); sharded counters in Postgres (works, but 50k/s of transactions for 98% "no" answers is waste).

**2. Redis failover (twist, part 1).** Redis replication is asynchronous: the promoted replica can miss the last writes. Effects: some `DECR`s and `SADD`s are lost, so the gate admits a few more requests than stock, and a user might pass the "one per customer" check twice. Postgres catches both: `remaining > 0` with the CHECK prevents oversell, and `UNIQUE (sale_id, user_id)` prevents a second reservation. Over-admitted users see "sold out" after "securing your pair…", which is why the UI never says "you got it" before Postgres confirms. `WAIT 1 50` after the script narrows the loss window but doesn't close it. Rejected: Redis as the inventory truth.

**3. Unpaid 15% (twist, part 2).** ~1,500 pairs come back over 10+ minutes. If they silently return to the gate, bots polling the endpoint get them. Chosen: a waitlist. Users who got "sold out" can join; released pairs are offered in waitlist order with a 5-minute window each (same reservation path, `UNIQUE` still applies). Reduce the unpaid rate up front: require a saved card and authorize at reservation time, so "paid" is usually a capture. Rejected: no expiry (pairs locked forever), immediate public re-release.

**4. Raffle alternative.** If fairness matters more than speed, take entries for 15 minutes, draw winners, and charge them. No contention, no bots advantage from speed. Worth proposing.

## Traps

- Check-then-decrement in application code (`if stock > 0` then `stock - 1` in two calls): concurrent requests both pass and oversell.
- Making Redis the only source of truth for inventory: asynchronous replication loses decrements on failover.
- Telling the user "you got it" from the Redis gate before the database confirms.
- Letting the flash sale share the main checkout's database pool and capacity: the whole store goes down for a sneaker drop.
- No reservation expiry, or expiry that silently returns stock to whoever's bot polls fastest.
- A per-user limit enforced only in Redis: same failover problem; back it with a unique constraint.

## Say it (60–90 s)

Only ten thousand of fifty thousand requests a second can succeed, so the design is about answering the other ninety-eight percent cheaply and never overselling. The page and the sold-out flag are on the CDN. A buy request runs one Lua script in Redis that checks the user hasn't already reserved, checks stock for that size, decrements it, records the buyer and appends to a stream, atomically. That gate lets roughly the stock through. A consumer then confirms each reservation in Postgres with a conditional decrement where remaining is greater than zero, plus a unique constraint on sale and user. Postgres sees about ten thousand writes, so its row locks are fine; that's the reason for the gate, since one hot row handles about a thousand updates a second. The user sees "securing your pair" until Postgres confirms. If Redis fails over and loses a few writes, the gate admits a few extra people, but Postgres still refuses to oversell or double-reserve; they just see sold out. Reservations expire after ten minutes; returned pairs go to a waitlist in order, not back to whoever's bot polls fastest. Authorizing the card at reservation lowers the unpaid rate.

## Follow-ups

**Q:** How do you load-test this?
**A:** Replay a synthetic 50k req/s burst against a staging copy with the same Redis instance type; verify the final Postgres count equals stock, the unique constraint holds, and p99 for "sold out" answers stays low. Also run a forced Redis failover during the test.

**Q:** Why a Redis stream and not SQS between gate and Postgres?
**A:** XADD in the same script makes the reservation record atomic with the decrement. With SQS, the script succeeds and the send can fail. A stream consumer group still gives at-least-once delivery; the Postgres unique constraint makes it idempotent.

**Q:** How do the 12 sizes interact?
**A:** Separate stock keys, shared buyers set (one pair per customer). All keys share the `{sale42}` hash tag so one script can touch them.

</details>

## Theory in the notes

- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
