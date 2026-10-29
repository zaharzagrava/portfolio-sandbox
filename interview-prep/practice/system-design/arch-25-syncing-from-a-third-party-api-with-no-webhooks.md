# arch-25. Syncing from a third-party API with no webhooks

*Integrations · Medium*

## The question

"We sell an inventory-planning SaaS. 400 customers connect their cloud ERP, and we need their orders, products and stock levels. The ERP API has no webhooks: `GET /orders?modified_since=…` (same for products and stock), page-number pagination, 100 records per page, and our partner app key is limited to 300 requests/minute across all our customers. Customers range from 1k to 2M orders. Changes must show up within 15 minutes, and a new customer brings 2 years of history."

**Then:** "You find that `modified_since` has one-second precision, the ERP's clock is 40 seconds off from ours, and deleted orders just disappear. And a new 2M-order customer's import makes every other customer's sync fall behind."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Sort and inclusivity? → assume: sorting by `modified_at` ascending is supported; `modified_since` is inclusive.
- Change log or version field? → assume: `modified_at` only, no version, no change feed.
- Bulk export? → assume: none. If the ERP offered a bulk export job, I'd use it for history.
- Which entities how fast? → assume: orders and stock within 15 min; products hourly.
- Rate-limit behavior? → assume: 429 with `Retry-After`; repeated violations can suspend the key (affecting all 400 customers).
- Budget math → assume: idle incremental polling of 400 customers × 2 urgent entities every 10 min = 80 req/min, leaving the rest for multi-page deltas, hourly products and imports. A 2M-order import = 20k requests: at 150 req/min ≈ 2.2 hours.

## Design

**1. Cursors** (Postgres):
```sql
sync_cursors(customer_id, entity, cursor_ts timestamptz,      -- THEIR modified_at, never our clock
  next_run_at, interval_s int, lease_until, status, last_success_at,
  PRIMARY KEY (customer_id, entity))
```
A scheduler (every 30 s, any replica) claims due cursors with `FOR UPDATE SKIP LOCKED`, sets `lease_until = now() + 5 min`, enqueues jobs.

**2. Incremental job.** Request `modified_since = cursor_ts − 5 min overlap`, sorted ascending. Map each record through the same pure adapter mapper used everywhere; upsert by `(customer_id, external_id)` only if `content_hash` changed. After each page, restart the query from the max `modified_at` seen instead of asking for page N+1. Advance `cursor_ts` in the same transaction as the page's upserts.

**3. Shared rate limit.** One Redis token bucket for the app key, Lua script using Redis `TIME`, target 250/min (headroom for retries and unknown window alignment). Priority by reserve: incremental syncs take any token; imports only when ≥ 40% of the bucket remains. On any 429: set `paused_until` in Redis for `Retry-After` so all workers stop, then halve the rate and ramp back slowly (AIMD).

**4. Fairness.** Work is claimed per customer, oldest-waiting customer first, at most 2 in-flight requests per customer; a job processes at most 20 pages, then requeues.

**5. Import (backfill).** `import_chunks(customer_id, entity, cursor, status)` claimed by a separate pool. Raw pages → S3 (`raw/{customer}/{entity}/{page}.json`) → mapper → `COPY` into staging → merge in batches of 1-5k rows, each a short transaction, with `WHERE target.source_modified_at < EXCLUDED.source_modified_at`. Pause between batches when replica lag > 5 s. The customer's incremental cursor starts at the import's snapshot time, so changes made during the import are picked up after it.

**6. Deletes.** Nightly ID scan per customer (IDs only); records we have that they don't → `missing_since`; second consecutive miss + a confirming 404 on `GET /orders/{id}` → soft delete.

**7. SLA metric:** sync age per customer/entity = `now() − last_success_at`; alert when p95 > 15 min.

## Deep dives

**1. Cursor correctness (twist, part 1).** Three ways to lose changes: (a) one-second precision with strict `>` drops rows sharing the cursor's second; (b) a cursor taken from our `now()` is 40 s ahead of their clock and skips changes; (c) their in-flight transactions commit later with an earlier `modified_at`. Chosen: cursor from their own `modified_at` values only, inclusive query, an overlap window larger than skew plus their commit latency, dedupe by content hash. Rejected: our clock as cursor; strict `>`.

**2. Page-number drift.** Sorted by `modified_at`, a record updated mid-sync jumps to the end and every later record shifts one position left, so page 2 skips one. Chosen: restart from the last seen timestamp after each page (keyset emulation); if one second holds more than a page of rows, page within that second until exhausted. Rejected: plain `page=1..N` for large customers.

**3. Import starving everyone (twist, part 2).** A FIFO queue puts 20k import requests ahead of everyone's 15-minute deltas. Chosen: imports run only on spare tokens (reserve rule), in a separate worker pool, with per-customer in-flight caps; the import takes longer, nobody else notices. Rejected: a static per-worker split of the limit (wrong after every scale-out); per-process limiters (N workers × limit = 429s and a suspended key).

**4. Deletes (twist, part 1).** A record disappearing can be a delete, a permission change or a partial API failure. Chosen: two consecutive misses + a confirming 404 + soft delete, and never trigger irreversible actions (cancelling purchase orders) on a delete without review.

## Traps

- Using our clock for the cursor.
- Advancing the cursor before the data is committed.
- Strict `>` on a one-second timestamp.
- Assuming page-number pagination is stable while data changes.
- A rate limiter per process instead of one per API key.
- One giant transaction for the import, or importing through the normal write path so every historical order fires alerts and recalculations.

## Say it (60–90 s)

The ERP gives me state, not events, so this is a state sync with our own change detection. I keep a cursor per customer and entity, stored as the ERP's own modified-at value, never our clock, because theirs is forty seconds off. A scheduler claims due cursors with SKIP LOCKED, and a worker queries modified-since the cursor minus a five-minute overlap, inclusive, so ties on one-second timestamps and late commits on their side aren't lost. Overlap duplicates are cheap because I upsert only when the content hash changes. After each page I restart the query from the last timestamp seen instead of asking for page two, because their pages shift when records change mid-sync, and the cursor advances in the same transaction as the upserts. All workers share one Redis token bucket for the three-hundred-per-minute key, with headroom, a global pause on any 429, and a reserve so imports only use spare capacity. Work is claimed per customer with a cap on in-flight requests, which is why the two-million-order import no longer slows everyone: it just takes about two hours. Imports go through S3, staging tables and small merge batches. Deletes come from a nightly ID scan, confirmed by a 404 before a soft delete.

## Follow-ups

**Q:** The ERP is down for three hours.
**A:** Circuit breaker per vendor; cursors don't move; catch-up afterwards is just a bigger delta, rate-limited like everything else. The sync-age alert fires at 15 minutes, tagged with the vendor, and the status page says so.

**Q:** The vendor adds webhooks later.
**A:** A webhook becomes a wake-up that schedules that customer's sync now; polling stays as the safety net with a longer interval.

**Q:** Why keep raw pages in S3?
**A:** A mapper bug fix becomes a replay from S3 through the fixed mapper, with no API calls against the shared limit.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
