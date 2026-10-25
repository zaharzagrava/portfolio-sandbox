# arch-09. Idempotent payment-creation API

*Payments · Easy*

## The question

Our mobile app calls `POST /payments` to pay rent. On flaky networks the app retries, and we've seen a double-tap send two requests 50 ms apart. Design the API so a tenant is charged at most once per intended payment.

**Then:** The first request is still running (waiting 8 seconds on the payment provider) when the retry arrives. What does the retry get back?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Who generates the key? → assume: the client, one UUID per payment intent (created when the tenant taps "Pay"), reused on every retry of that tap.
- Key scope? → assume: per tenant, `(tenant_id, key)`.
- How long are keys kept? → assume: 24-72 hours (Stripe keeps keys at least 24 h).
- Same key, different body? → assume: rejected with 422.
- Also guard against two different keys for the same rent charge (two devices)? → assume: yes, one in-flight payment per charge.
- Does the provider support idempotency keys? → assume: yes.

## Design

```sql
idempotency_keys(tenant_id uuid, key text, request_hash bytea,
  status text,               -- in_progress | completed
  response_code int, response_body jsonb, payment_id uuid,
  locked_until timestamptz, created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, key))

CREATE UNIQUE INDEX one_open_payment_per_charge
  ON payments (charge_id) WHERE status IN ('pending', 'processing');
```

**Flow**
1. Require `Idempotency-Key`; missing → 400.
2. Short transaction: `INSERT … (status 'in_progress', request_hash = sha256(canonical body), locked_until = now() + 60s) ON CONFLICT DO NOTHING RETURNING *`.
3. **Inserted → this request owns the key.** Insert the `payments` row (`pending`, linked to the key) and commit. Call the provider outside any transaction, with provider idempotency key = our payment id. Record the outcome, then store the response on the key row: `completed`, code, body.
4. **Not inserted → read the row:**
   - `request_hash` differs → 422 "key reused with different parameters".
   - `completed` → replay stored code and body (the same 201, or the same 402 decline).
   - `in_progress` and `locked_until` in the future → 409 Conflict with `Retry-After: 1` (the IETF Idempotency-Key draft uses 409 for a request still in flight).
   - `in_progress` and lock expired (the owner crashed) → take over: if a payment row exists, ask the provider for its result by our payment id; never create a second charge.
5. **Errors:** failure before any side effect (validation, DB down) → delete the key row so a retry starts fresh. After the provider was called, store the final outcome.
6. **Cleanup:** delete keys older than 72 h in batches.

## Deep dives

**1. Concurrent duplicates.** SELECT-then-INSERT races: both requests see "no key" and both charge. Chosen: the primary key + `INSERT … ON CONFLICT`, which Postgres makes atomic. Rejected: Redis `SETNX` as the only guard (not in the same transaction as the payment row, and an expiring lock can release while the first request still runs).

**2. The in-flight retry (the twist).** Options: block until the first finishes, or answer 409 + `Retry-After`. Chosen: wait up to ~1-2 s polling the row, then 409; the app retries and then gets the stored result. Holding the request open 8 s ties up a connection per duplicate on rent day.

**3. No transaction across the provider call.** Holding a DB transaction or row lock for 8 s per payment exhausts the connection pool at rent-day volume. The status column + `locked_until` replaces the lock.

**4. Provider-side idempotency.** If our process dies after the provider charged but before we stored the result, the takeover path calls the provider again with the same idempotency key (our payment id) and gets the original result, not a new charge.

## Traps

- Generating the key on the server; the server can't tell a retry from a new payment.
- A new UUID per HTTP attempt instead of per user intent.
- Dedupe by "same tenant and amount within a minute"; it blocks legitimate payments and misses retries after a minute.
- Holding a transaction open during the provider call.
- Ignoring a different body under the same key.
- Keeping keys in a store separate from the payment row, so they can disagree after a crash.

## Say it (60–90 s)

The client creates one idempotency key per payment intent and sends it on every retry. On the server, the first thing in a short transaction is an insert into an idempotency table keyed by tenant and key, with on conflict do nothing. That makes concurrent duplicates safe, because Postgres lets only one insert win. The winner creates the payment row, commits, and calls the provider outside any transaction, using our payment id as the provider's idempotency key, then stores the final response on the key row. A request that loses the insert reads the row: a different body hash gets 422, a completed key replays the stored response, and a key still in progress gets 409 with Retry-After after a short wait. That's the answer to the twist: the retry gets 409, and the next retry gets the stored result. If the owner crashed, its lock expires and the next request asks the provider by our payment id instead of charging again. I also add a partial unique index so a charge can't have two open payments from two devices.

## Follow-ups

**Q:** Postgres or Redis for the keys?
**A:** Postgres, in the same database as payments, so the key and the payment row can't disagree. Redis only as an optional fast path.

**Q:** The client never retries after a crash mid-flight.
**A:** A sweeper resolves stale `pending` payments with the provider and finalizes them; the app shows the result on next load.

**Q:** Do GET endpoints need keys?
**A:** No. Only requests with side effects: POST, and PATCH where it isn't naturally idempotent.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
