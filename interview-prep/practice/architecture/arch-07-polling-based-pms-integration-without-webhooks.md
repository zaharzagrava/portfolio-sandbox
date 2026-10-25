# arch-07. Polling-based PMS integration without webhooks

*Integrations · Medium*

## The question

A PMS partner has no webhooks. Their API has `GET /leases?modified_since=…` (also tenants, units, charges) with page-number pagination, max 100 per page, and one integration key limited to 300 requests/minute across all our customers. We have 400 customer accounts on them, from 50 to 20,000 leases each. Changes must show up on our side within 15 minutes. Design the sync.

**Then:** You find that `modified_since` has one-second precision, their clock is 40 seconds off from ours, and deleted leases simply disappear from the list. What changes?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Can results be sorted by modification time, and is `modified_since` inclusive? → assume: sort by `modified_at` ascending is supported; inclusive.
- Is there any changelog or version field per record? → assume: `modified_at` only, no version.
- Which entities and how urgent? → assume: charges and leases within 15 min; properties and units hourly is fine.
- Deletes visible? → assume: no (the twist confirms it).
- Do we need intermediate states? → assume: no; state sync is enough. Money transitions are decided by our own system.
- Rate-limit response? → assume: 429 with `Retry-After`.

## Design

**Components:** scheduler, sync workers, shared rate limiter (Redis), Postgres. Same adapter/canonical model as the webhook partners; only the transport differs.

```sql
sync_cursors(partner_id, account_id, entity,
  cursor_ts timestamptz,       -- THEIR modified_at, never our clock
  next_run_at timestamptz, interval_s int, lease_until timestamptz, status, last_success_at,
  PRIMARY KEY (partner_id, account_id, entity))
```
1. **Scheduler** (every 30 s): claim due cursors with `FOR UPDATE SKIP LOCKED`, set `lease_until = now() + 5 min`, enqueue jobs. Any replica can run it; locks prevent double runs.
2. **Job:** request `modified_since = cursor_ts − overlap` (overlap 2-5 min), sorted ascending. For each record: canonical mapping, then upsert by `(partner_id, external_id)` only if `content_hash` differs. Overlap re-reads are no-ops.
3. **Paging:** instead of trusting page N+1 while data changes, after each page restart the query with `modified_since = max(modified_at in page)`; dedupe by id + hash.
4. **Advance the cursor** in the same transaction as the page's upserts, to the max partner `modified_at` seen.
5. **Rate limiting:** one Redis token bucket for the partner key (300/min), shared by all workers. Budget: incremental syncs first, reserve ≥ 30% for them; backfills get the rest. On 429: honor `Retry-After`, halve the rate, ramp back slowly.
6. **Adaptive intervals:** `interval_s` shrinks for accounts with recent changes and grows for quiet ones. Budget math: 400 accounts × 2 urgent entities every 10 min = 80 req/min when nothing changed; leaves room for multi-page accounts and hourly entities.
7. **Change detection:** diff old vs new canonical record → our own events (`RentChanged`, `LeaseEnded`).
8. **Deletes:** nightly id scan per account (ids only, cheap fields): ids we have that they don't → mark `missing_since`; second consecutive miss → confirm with `GET /leases/{id}` (404) → soft delete.
9. **SLA metric:** per account/entity sync age = `now() − last_success_at`; alert when p95 > 15 min.

## Deep dives

**1. Cursor correctness (the twist).** Three ways to lose changes: (a) one-second precision with ties, so a strict `>` drops rows sharing the cursor second; (b) their clock vs ours, so a cursor taken from our `now()` is 40 s ahead and skips changes; (c) their in-flight transactions commit later with an earlier `modified_at`. Chosen: cursor from their own `modified_at` values only, inclusive query, an overlap window larger than skew and their commit latency, and dedupe by hash. Rejected: our clock as cursor; strict `>`.

**2. Page-number drift.** Sorted by `modified_at`, a record updated mid-sync jumps to the end, every later record shifts left one position, and page 2 skips one record. Chosen: re-query from the last seen timestamp after each page (keyset emulation). If a single second contains more than one page of rows, page within that second until it's exhausted. Rejected: plain `page=1..N` for large accounts.

**3. Fairness under one key.** A 20,000-lease account's initial sync could take the whole budget. Chosen: a max page count per job (e.g. 20), then requeue; round-robin across accounts; priority lanes so incremental syncs always get capacity. Rejected: an in-memory limiter per worker (N workers × limit = 429s).

**4. Deletes.** Disappearance can be a delete, a permission change or a partial API failure. Chosen: two consecutive misses + a confirming 404 + soft delete, and never auto-cancel money flows (autopay) on a delete without review. Rejected: deleting on first miss.

## Traps

- Using our clock for the cursor.
- Advancing the cursor before the data is committed.
- Strict `>` on a one-second timestamp.
- Assuming page-number pagination is stable while data changes.
- A rate limiter per process instead of one per partner key.
- Treating a missing record as deleted and cancelling autopay automatically.

## Say it (60–90 s)

The partner gives me state, not events, so this is a state sync with our own change detection. I keep a cursor per account and entity, stored as the partner's own modified-at value, never our clock, because their clock can be off. A scheduler claims due cursors with SKIP LOCKED, and a worker queries modified-since the cursor minus a few minutes of overlap, inclusive, so ties on one-second timestamps and late commits on their side aren't lost. Overlap duplicates are cheap: I upsert only when the content hash changes. After each page I restart the query from the last timestamp seen instead of asking for page two, because their pages shift when records are updated mid-sync. The cursor advances in the same transaction as the upserts. All workers share one Redis token bucket for the 300-per-minute key, with priority for incremental syncs and a page cap per job so one big account can't starve others. Deletes come from a nightly id scan, with two misses and a confirming 404 before a soft delete. I alert on sync age per account at 15 minutes.

## Follow-ups

**Q:** Their API is down for three hours.
**A:** Circuit breaker per partner; cursors don't move; catch-up after recovery is just a bigger delta. The sync-age alert fires at 15 minutes and is tagged with the partner.

**Q:** The partner adds webhooks later.
**A:** A new adapter capability. A webhook becomes a wake-up that schedules that account's sync now; polling stays as the safety net with a longer interval.

**Q:** Why a content hash and not just upsert everything?
**A:** Overlap windows re-read many unchanged rows; writing them anyway creates WAL, bloat and fake change events.

</details>

## Theory in the notes

- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
- [practice/01-pms-webhook-ingestion.md](../../practice/01-pms-webhook-ingestion.md)
