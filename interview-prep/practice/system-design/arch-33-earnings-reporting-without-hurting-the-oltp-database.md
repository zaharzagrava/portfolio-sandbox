# arch-33. Earnings reporting without hurting the OLTP database

*Data · Hard*

## The question

"Our food delivery marketplace needs earnings reports: order value, commissions, delivery fees, refunds and payouts by restaurant, city and payment method, plus a restaurant dashboard with 24 months of history. Today these are SQL queries on the primary Postgres (RDS, 2 TB). On the 1st of each month, when restaurants download statements and finance closes the month, API p99 goes from 80 ms to 2 s. Design the reporting path."

**Then:** "The CFO says October revenue on the dashboard changed between Monday and Thursday, and doesn't match the board deck."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Freshness? → assume: finance needs the closed month; the restaurant dashboard can be ~15 min behind; "today" can be approximate.
- Definition of revenue? → assume: commission + fees on completed orders, net of refunds; finance owns the definitions, we encode them once.
- Month boundaries in which time zone? → assume: our books in UTC; restaurant statements in the restaurant's local zone. Stated on every report.
- Late events (refunds, card chargebacks after month end)? → assume: closed months are frozen; late items land as adjustments in the period they occur.
- Volume? → assume: 15M orders/month, ~5 ledger entries per order, so ~75M ledger rows a month.
- Team? → assume: no data engineers yet; fewer moving parts wins.

## Design

**Stage 1: off the primary, rollups instead of scans (days of work).**
1. **Reporting replica**, separate from any replica serving the API. Long queries on a streaming replica conflict with WAL replay: with `hot_standby_feedback = off` they get cancelled ("conflict with recovery"); with it `on` they hold back vacuum on the primary. Set `max_standby_streaming_delay` high on this replica only (e.g. 15 min): it may lag during heavy queries, which reports tolerate.
2. **Rollup table** built from the append-only ledger, not from mutable order rows:
```sql
CREATE TABLE daily_earnings (
  restaurant_id uuid, city_id int, method text, currency char(3), day date,
  gross_minor bigint, commission_minor bigint, delivery_fee_minor bigint,
  refunds_minor bigint, payouts_minor bigint, orders int,
  PRIMARY KEY (restaurant_id, method, currency, day));
```
A job every 15 min reads new ledger entries on the replica, collects the affected `(restaurant, day)` keys, re-aggregates those days fully, and upserts the results on the primary (small writes). `day` is computed in the restaurant's time zone.
3. **Dashboard** reads rollups only: 24 months is ~730 rows per method per restaurant, milliseconds.
4. **Month close.** Finance closes a period: `period_closes(month, closed_at, totals jsonb, approved_by)`. Closed numbers are frozen; ledger entries for a closed month posted after close go to an adjustments line in the current open month.
5. **Invariant check, daily:** sum of rollups per currency and day = sum of ledger entries; mismatch alerts.

**Stage 2: warehouse, when sources multiply** (PSP settlement reports, courier payroll, product analytics) or ad-hoc analysis grows.
6. CDC: logical replication → Debezium or AWS DMS → S3 Parquet → Athena, Redshift or Snowflake; or an AWS zero-ETL integration into Redshift where the engine version supports it. Revenue definitions live in versioned SQL models (e.g. dbt) used by both the dashboard and finance.
7. Replication slots keep WAL until the consumer reads it: set `max_slot_wal_keep_size` (13+) and alert on slot lag.

## Deep dives

**1. Incremental aggregation that doesn't miss rows.**
Problem: "process ledger entries with id > last watermark" skips rows. Identity values are assigned at insert, but a transaction that got id 1000 can commit after one that got id 1001; if the job ran in between, 1000 is never seen.
Approach: re-aggregate whole affected days, and find affected days by scanning entries with `created_at > last_run - 10 min` (an overlap larger than the longest allowed transaction, enforced by `statement_timeout` and `idle_in_transaction_session_timeout`). Re-aggregation is idempotent, so the overlap costs only CPU.
Rejected: `REFRESH MATERIALIZED VIEW CONCURRENTLY` over the 2 TB base. It doesn't block readers (it needs a unique index), but it recomputes everything on every refresh. Fine for small summaries built on top of the rollups.

**2. Replica conflicts.**
Problem: "just use a replica" ignores how a hot standby works.
Approach: a dedicated reporting replica with a long standby delay, rollups so queries are small anyway, `statement_timeout` for BI users.
Rejected: heavy reports on the primary "at night": restaurants download statements whenever they want.

**3. Numbers that move (twist).**
Problem: Monday vs Thursday differ, and neither matches the deck.
Approach: find which of three causes it is. (a) Late events: refunds and chargebacks for October landed after Monday; fix with period close: the dashboard shows "October as closed" and "adjustments since close" separately. (b) Time zones: an order at 23:30 on Oct 31 in Los Angeles is November in UTC; one stated reporting zone per report. (c) Definitions: the deck used gross order value, the dashboard net revenue; one versioned definition used by both. Then reconcile rollups → ledger → PSP settlement reports.
Rejected: recomputing past months from current state (current commission rates, current order status). History comes from ledger entries as they were posted.

## Traps

- **Pointing BI tools at the primary.**
- **"A replica is free"**: query cancellations, vacuum held back by `hot_standby_feedback`, lag.
- **A replication slot without monitoring**: WAL piles up until the primary's disk is full.
- **Summing across currencies**, or report amounts as floats.
- **One time zone for everything** without saying which.
- **Rebuilding past months from current state** instead of posted ledger entries.

## Say it (60–90 s)

First I'd get reporting off the primary, but not by just pointing it at a replica, because long queries on a streaming replica either get cancelled or, with hot standby feedback, hold back vacuum on the primary. So: a dedicated reporting replica with a long standby delay, and, more importantly, small queries. I'd build a daily earnings rollup keyed by restaurant, payment method, currency and day, from the append-only ledger. A job every fifteen minutes finds which days got new entries, re-aggregates those whole days and upserts them; re-aggregating whole days with an overlap window avoids the trap where a lower id commits after a higher one and a watermark skips it. The dashboard reads only rollups, so twenty-four months is milliseconds. Finance closes each month, closed numbers are frozen, and late refunds or chargebacks show as adjustments in the next period. A daily check asserts that rollups equal the ledger. That also explains the CFO's moving number: late events, time zones, or two definitions of revenue, and period close plus one definition fixes it. I'd add a warehouse with CDC only when we need to join PSP and other sources, and then I'd monitor replication slot lag.

## Follow-ups

**Q:** Why not Redshift from day one?
**A:** No data team yet, and rollups plus a replica cover these reports. A warehouse pays off when we join several sources or analysts need ad-hoc access.

**Q:** How do restaurant dashboards stay isolated?
**A:** Rollups carry `restaurant_id`; the dashboard API applies the same scoping as the rest of the app. Restaurants never get direct BI tool access.

**Q:** How do you test report correctness?
**A:** Invariants (rollups = ledger per day and currency), reconciliation with PSP settlement totals, and a fixture month with known answers in CI, including an order across midnight and a refund after close.

</details>

## Theory in the notes

- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
