# arch-34. Monthly revenue reporting without hurting the OLTP database

*Data · Hard*

## The question

Finance and landlords want monthly revenue reports: collected rent, platform fees, refunds, chargebacks and payouts, by landlord, property and payment method, plus a landlord dashboard with 24 months of history. Today these are SQL queries on the primary Postgres (RDS, 2 TB), and on the 2nd of each month they push API p99 from 80 ms to 2 s. Design the reporting path.

**Then:** The CFO says October revenue on the dashboard changed between Monday and Thursday, and doesn't match the board deck.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Freshness? → assume: finance needs the closed month; the landlord dashboard can be up to ~15 min behind; "today" numbers can be approximate.
- Definition of revenue? → assume: platform fees on settled payments net of refunds; finance owns the definitions, we encode them once.
- Month boundaries in which time zone? → assume: Asia/Jerusalem for our books; the landlord's local zone for landlord reports. Stated on every report.
- Late events (bank returns, chargebacks after month end)? → assume: closed months are frozen; late items land as adjustments in the period they occur.
- Volume? → assume: 400k payments/month, a few million ledger entries/month.
- Team? → assume: no data engineers yet; fewer moving parts wins.

## Design

**Stage 1: off the primary, rollups instead of scans (days of work).**
1. **Reporting replica**, separate from any replica serving the API. Long queries on a streaming replica conflict with WAL replay: with `hot_standby_feedback = off` they get cancelled ("conflict with recovery"); with it `on` they hold back vacuum on the primary. Set `max_standby_streaming_delay` high on this replica only (e.g. 15 min): it may lag during heavy queries, which reports tolerate.
2. **Rollup table** built from the append-only ledger, not from mutable payment rows:
```sql
CREATE TABLE daily_revenue (
  org_id uuid, property_id uuid, method text, currency char(3), day date,
  gross_minor bigint, fees_minor bigint, refunds_minor bigint,
  chargebacks_minor bigint, payouts_minor bigint,
  PRIMARY KEY (org_id, property_id, method, currency, day)
);
```
A job every 15 min reads new ledger entries on the replica, collects the set of affected `(org, property, day)` keys, re-aggregates those days fully, and upserts the results on the primary (small writes). `day` is computed in the reporting time zone.
3. **Dashboard** reads rollups only: 24 months × properties is thousands of rows per landlord, milliseconds.
4. **Month close.** Finance closes a period: `period_closes(month, closed_at, totals jsonb, approved_by)`. Closed numbers are frozen; ledger entries for a closed month after close go into an adjustments line of the current open month.
5. **Invariant check, daily:** sum of rollups per currency and day = sum of ledger entries; mismatch alerts.

**Stage 2: warehouse, when sources multiply** (PSP fee reports, bank statements, product analytics) or ad-hoc analysis grows.
6. CDC: logical replication → Debezium or DMS → S3 Parquet → Athena/Redshift/Snowflake; or an AWS zero-ETL integration into Redshift where the engine version supports it. Revenue definitions live in versioned SQL models (e.g. dbt) used by both the dashboard and finance.
7. Replication slots retain WAL until the consumer reads it: set `max_slot_wal_keep_size` (13+) and alert on slot lag, or a stalled consumer fills the primary's disk.

## Deep dives

**1. Incremental aggregation that doesn't miss rows.**
Problem: "process ledger entries with id > last watermark" skips rows. Identity values are assigned at insert, but a transaction that got id 1000 can commit after one that got id 1001; if the job ran in between, 1000 is never seen.
Approach: re-aggregate whole affected days, and find affected days by scanning entries with `created_at > last_run - 10 min` (an overlap larger than the longest allowed transaction, enforced by `statement_timeout` / `idle_in_transaction_session_timeout`). Re-aggregation is idempotent, so the overlap costs only CPU.
Rejected: `REFRESH MATERIALIZED VIEW CONCURRENTLY` over the 2 TB base: it doesn't block readers (needs a unique index) but recomputes everything on each refresh. Fine for small summaries built on top of the rollups.

**2. Replica conflicts.**
Problem: "just use a replica" ignores how a hot standby works.
Approach: dedicated reporting replica with a long standby delay, rollups so that queries are small anyway, `statement_timeout` for BI users.
Rejected: running heavy reports on the primary "at night": finance runs them on the 2nd at 9:00, and landlords look whenever they want.

**3. Numbers that move (twist).**
Problem: Monday vs Thursday differ, and neither matches the deck.
Approach: find which of three causes it is. (a) Late events: bank returns and chargebacks landed for October after Monday; fix with period close: the dashboard shows "October as closed" and "adjustments since close" separately. (b) Time zone: payments at 23:30 on Oct 31 Israel time fall into November in UTC; one reporting zone, printed on the report. (c) Definitions: the deck used gross, the dashboard net; one versioned definition used by both. Then reconcile rollups → ledger → PSP settlement reports.
Rejected: recomputing past months from current state (current fee config, current payment status). History must come from ledger entries as they were posted.

## Traps

- **Pointing BI tools at the primary.**
- **"A replica is free"**: query cancellations, vacuum held back by `hot_standby_feedback`, lag.
- **Replication slot without monitoring**: WAL accumulates until the primary's disk is full.
- **Summing across currencies** or storing report amounts as floats.
- **Month boundaries in UTC** for a business that closes its books in Israel time.
- **Rebuilding past months from current state** instead of posted ledger entries.

## Say it (60–90 s)

First I'd get reporting off the primary, but not by just pointing it at a replica, because long queries on a streaming replica either get cancelled or, with hot standby feedback, hold back vacuum on the primary. So: a dedicated reporting replica with a long standby delay, and, more importantly, queries that are small. I'd build a daily revenue rollup table keyed by org, property, method, currency and day, from the append-only ledger. A job every fifteen minutes finds which days got new entries, re-aggregates those whole days and upserts them; re-aggregating whole days with an overlap window avoids the trap where a lower id commits after a higher one and a watermark skips it. The dashboard reads only rollups, so twenty-four months is milliseconds. Finance closes each month, closed numbers are frozen, and late returns or chargebacks show as adjustments in the next period. A daily check asserts rollups equal the ledger. That explains the CFO's moving number: late events, time zone, or two definitions of revenue, and close plus one definition fixes it. I'd add a warehouse with CDC only when we need to join PSP and bank data, and then I'd monitor replication slot lag.

## Follow-ups

**Q:** Why not Redshift from day one?
**A:** No data team yet, and rollups plus a replica cover these reports. A warehouse pays off when we join several sources or analysts need ad-hoc access.

**Q:** How do landlord dashboards stay isolated?
**A:** Rollups carry `org_id`; the dashboard API applies the same org scoping (and RLS) as the rest of the app. Landlords never get direct BI tool access.

**Q:** How do you test report correctness?
**A:** Invariants (rollups = ledger per day and currency), reconciliation with PSP settlement totals, and a fixture month with known answers in CI.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
