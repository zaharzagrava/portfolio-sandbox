# arch-23. Idempotent create-order API

*API Design · Easy*

## The question

"Our grocery delivery app calls `POST /orders`, which places the order and authorizes the customer's card. On flaky mobile networks the app retries, and we've seen a double-tap send two requests 50 ms apart. Design the API so a customer gets at most one order and one card authorization per checkout."

**Then:** "The first request is still running, waiting 8 seconds on the payment provider, when the retry arrives. What does the retry get back?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who generates the key? → assume: the client, one UUID per checkout attempt (created when the user taps "Place order"), reused on every retry of that tap.
- Key scope? → assume: per customer, `(customer_id, key)`.
- How long are keys kept? → assume: 24-72 hours (Stripe keeps keys for at least 24 h).
- Same key, different body? → assume: rejected with 422.
- Two devices, two keys, same cart? → assume: one open order per cart, enforced separately.
- Does the payment provider support idempotency keys? → assume: yes.

## Design

```sql
idempotency_keys(customer_id uuid, key text, request_hash bytea,
  status text,               -- in_progress | completed
  response_code int, response_body jsonb, order_id uuid,
  locked_until timestamptz, created_at timestamptz DEFAULT now(),
  PRIMARY KEY (customer_id, key))

CREATE UNIQUE INDEX one_open_order_per_cart
  ON orders (cart_id) WHERE status IN ('pending_payment', 'authorizing');
```

**Flow**
1. Require `Idempotency-Key`; missing → 400.
2. Short transaction: `INSERT … (status 'in_progress', request_hash = sha256(canonical body), locked_until = now() + 60s) ON CONFLICT DO NOTHING RETURNING *`.
3. **Inserted → this request owns the key.** Insert the `orders` row (`pending_payment`, linked to the key) and commit. Call the provider outside any transaction, with the provider's idempotency key = our order ID. Record the outcome (`authorized` / `declined`), then store the response on the key row: `completed`, code, body.
4. **Not inserted → read the row:**
   - `request_hash` differs → 422 "key reused with different parameters".
   - `completed` → replay the stored code and body (the same 201, or the same 402 decline).
   - `in_progress` and `locked_until` in the future → 409 Conflict with `Retry-After: 1` (the IETF Idempotency-Key draft uses 409 for a request still being processed).
   - `in_progress` and lock expired (the owner crashed) → take over: if an order row exists, ask the provider for the authorization by our order ID; never authorize again blindly.
5. **Errors:** failure before any side effect (validation, DB down) → delete the key row so a retry starts fresh. After the provider was called, always store the final outcome.
6. **Cleanup:** delete keys older than 72 h in batches.

## Deep dives

**1. Concurrent duplicates.** SELECT-then-INSERT races: both requests see "no key" and both authorize. Chosen: the primary key + `INSERT … ON CONFLICT`, which Postgres makes atomic: only one insert wins. Rejected: Redis `SET NX` as the only guard (not in the same transaction as the order row, and an expiring lock can release while the first request is still running).

**2. The in-flight retry (the twist).** Options: block until the first finishes, or answer 409 + `Retry-After`. Chosen: wait up to ~1-2 s polling the key row, then 409; the app retries and gets the stored result once the first request completes. Holding the retry open for 8 s ties up a connection per duplicate at peak; returning a fake success would show an order that may still be declined.

**3. No transaction across the provider call.** Holding a DB transaction or row lock for 8 s per order exhausts the connection pool at dinner-time volume. The `status` column + `locked_until` replace the lock.

**4. Provider-side idempotency.** If our process dies after the provider authorized but before we stored the result, the takeover path calls the provider again with the same idempotency key (our order ID) and gets the original authorization, not a second hold on the card.

## Traps

- Generating the key on the server: the server can't tell a retry from a new order.
- A new UUID per HTTP attempt instead of per user action.
- Dedupe by "same customer and same total within a minute": blocks legitimate repeat orders and misses retries after a minute.
- Holding a database transaction open during the provider call.
- Ignoring a different body under the same key.
- Keeping keys in a store separate from the order row, so they can disagree after a crash.

## Say it (60–90 s)

The client creates one idempotency key per checkout tap and sends it on every retry. On the server, the first thing in a short transaction is an insert into an idempotency table keyed by customer and key, with on conflict do nothing. That makes concurrent duplicates safe, because Postgres lets only one insert win. The winner creates the order row, commits, and calls the payment provider outside any transaction, using our order ID as the provider's idempotency key, then stores the final response on the key row. A request that loses the insert reads the row: a different body hash gets 422, a completed key replays the stored response, and a key still in progress gets 409 with Retry-After after a short wait. That's the answer to the twist: the retry gets 409, and the next retry gets the stored result. If the owner crashed, its lock expires and the next request asks the provider by our order ID instead of authorizing again. A partial unique index on the cart also stops two devices with two different keys from placing two orders.

## Follow-ups

**Q:** Postgres or Redis for the keys?
**A:** Postgres, in the same database as orders, so the key and the order can't disagree. Redis only as an optional fast path in front.

**Q:** The app never retries after a crash mid-flight.
**A:** A sweeper resolves stale `pending_payment` orders with the provider by order ID and finalizes them (authorized → confirm order, unknown/declined → cancel and release the hold); the app shows the result on next launch.

**Q:** Do GET endpoints need keys?
**A:** No. Only requests with side effects: POST, and PATCH where it isn't naturally idempotent. PUT and DELETE are idempotent by definition if implemented correctly.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [04-api-design/01-rest-design-and-chatty-apis.md](../../04-api-design/01-rest-design-and-chatty-apis.md)
