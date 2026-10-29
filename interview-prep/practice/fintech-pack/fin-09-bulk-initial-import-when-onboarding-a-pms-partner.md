# fin-09. Bulk initial import when onboarding a PMS partner

*Fintech pack · Scaling · Medium*

## The question

A new PMS partner brings 500k tenants and leases plus ~3M historical charges across 800 property managers. Their API allows 600 requests/minute with 100 records per page, and their webhooks for live changes are already flowing during the import. We must import everything without slowing down live payment traffic in our Postgres. Design the backfill.

**Then:** Halfway through, you find a mapping bug that set the wrong rent due day on 40k leases. Autopay for some of those leases runs in 3 days.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Is there a bulk export (file to S3/SFTP)? → assume: no, API only. If yes, prefer it: one file instead of tens of thousands of calls.
- How much history? → assume: open balances + 12 months of charges for statements.
- Rate limit shared with live traffic? → assume: yes, same key; reserve a third for live calls.
- Do webhooks carry a version or `updated_at`? → assume: `updated_at` per record and event ids.
- Go-live granularity? → assume: per property manager, not all 800 at once.
- Side effects on import? → assume: none: no welcome emails, no autopay, no notifications until the PM is live.

## Design

**Size:** ~4M records / 100 per page ≈ 40k requests; at 400/min (leaving 200 for live) ≈ 100 minutes of fetching. The database load is the part to protect, not the duration.

1. **Job model:** `import_jobs(id, account_id, status, snapshot_started_at)` and `import_chunks(job_id, entity, cursor, status, attempts)` claimed by a dedicated worker pool with `SKIP LOCKED`; resumable after a crash.
2. **Order:** properties → units → tenants → leases → charges (foreign keys).
3. **Before fetching** an account: record `snapshot_started_at`, set the account to `importing`. Webhooks keep being stored in the inbox; processing for that account waits.
4. **Fetch:** a shared Redis token bucket for the partner key, import lane capped at 400/min. Raw pages go to S3 (`raw/{partner}/{account}/{entity}/{page}.json`), so a fix never requires fetching again.
5. **Map** with the same pure adapter mapper as live traffic, validate, then `COPY` into staging tables via `pg-copy-streams`.
6. **Merge** in batches of 1-5k rows, each its own short transaction:
```sql
INSERT INTO leases (...) SELECT ... FROM stg_leases WHERE batch_id = $1
ON CONFLICT (partner_id, external_id) DO UPDATE SET ...
WHERE leases.source_updated_at < EXCLUDED.source_updated_at;
```
7. **Throttle:** pause between batches when replica lag > 5 s or the payment API's p99 rises; DB connections for the import pool capped (e.g. 5).
8. **No side effects:** imported rows marked `origin = 'import'`; the account stays out of `live`, so autopay, reminders and notifications don't run.
9. **Catch-up:** after the merge, process the buffered webhooks for that account; the `source_updated_at` guard turns anything older than the snapshot into a no-op.
10. **Verify:** counts per entity vs the partner's totals, open balance per PM vs their report, a 1% field-by-field sample. Then PM → `shadow` → `live`.

Never run it in the last days of the month or the first week; `ANALYZE` the target tables after large merges.

## Deep dives

**1. Protecting live traffic.** Chosen: separate worker pool and connection cap, small merge batches, adaptive pauses on replica lag and API latency. Rejected: one big transaction per entity (long locks, WAL spike, replica lag, autovacuum blocked by a long-running transaction); rejected: dropping indexes on live tables to speed up inserts.

**2. Live webhooks during the import.** A snapshot row read at 10:00 can arrive after a webhook update from 10:05. Chosen: buffer the account's webhooks and apply them after the merge, with `source_updated_at` guards on every write. Rejected: pausing the partner's webhooks (their retries expire and changes are lost); applying both streams without a guard (older snapshot overwrites newer data).

**3. The mapping bug (the twist).** Because autopay only runs for `live` accounts, imported-but-not-live PMs are safe. For PMs already live: per-account kill switch on the autopay planner for affected leases, fix the mapper, replay the stored raw pages from S3 through the fixed mapper (no partner calls), produce a diff of changed fields, review, merge, re-enable. Occurrences already planned with the wrong date are re-planned. Rejected: patching due days with ad-hoc SQL; the next sync would revert them, and nobody can show what changed.

**4. Sharing the rate limit.** Priority lanes in one token bucket: live calls first, import gets the rest up to its cap; on 429 the import lane backs off first.

## Traps

- One giant transaction or one giant `INSERT … SELECT`.
- Importing through the public API endpoint row by row, triggering emails and autopay for 500k tenants.
- Ignoring changes that happen while the import runs.
- Not keeping raw pages; any mapping fix then means fetching everything again.
- Running the backfill near rent day.
- Using a separate mapper for the import than for live sync; the two drift.

## Say it (60–90 s)

The import is about 40k API calls, so roughly 100 minutes at a capped rate; the real job is protecting the live database. I run it per property manager with resumable chunks claimed by a separate worker pool with a small connection cap. Before fetching an account, I record a snapshot start time and keep storing that account's webhooks without processing them. Raw pages go to S3, then through the same pure mapper as live traffic, then COPY into staging tables, then merge into live tables in batches of a few thousand rows in short transactions, with an updated-at guard so older data never overwrites newer. I pause between batches when replica lag or payment latency rises. Imported accounts stay out of live, so no autopay or emails fire. After the merge I apply the buffered webhooks, verify counts and balances against the partner, and go live through shadow mode. For the bug: autopay is paused for affected leases, I fix the mapper and replay the raw pages from S3 without calling the partner, review the diff, merge and re-plan autopay.

## Follow-ups

**Q:** The import crashes at 60%.
**A:** Chunks and cursors are rows; raw pages are in S3; merges are idempotent upserts. Restart continues from the last completed chunk.

**Q:** The partner later offers a CSV export.
**A:** Use it: presigned upload to S3, streaming parse, same staging and merge path.

**Q:** Why staging tables instead of upserting straight from the mapper?
**A:** `COPY` is much faster than row inserts, validation can run as set-based SQL, and the merge batch size is controlled independently of the fetch rate.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [practice/01-pms-webhook-ingestion.md](../../practice/01-pms-webhook-ingestion.md)
