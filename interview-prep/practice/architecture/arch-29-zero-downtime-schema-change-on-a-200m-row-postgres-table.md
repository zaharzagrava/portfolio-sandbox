# arch-29. Zero-downtime schema change on a 200M-row Postgres table

*Data · Hard*

## The question

`payments` has 200M rows and takes 2-3k writes/s at peak. We need to add `settlement_currency char(3) NOT NULL`, backfilled per row from the payment's merchant account (another table), and rename `amount` to `amount_minor`. Postgres 15 on RDS, Node services with rolling deploys, one read replica and a CDC feed to the warehouse. No downtime, no long locks. Walk me through it.

**Then:** The `id` column is `integer`, and the sequence is at 1.9 billion. What now?

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Postgres version? → assume: 15. It decides what is metadata-only: fast non-volatile defaults (11+), `SET NOT NULL` skipping the scan when a valid CHECK proves it (12+), `NOT NULL ... NOT VALID` directly (18+).
- Long-running queries on this table? → assume: reporting queries up to minutes on the primary. They're why a "fast" ALTER can still cause an outage.
- Who reads `amount` outside this service? → assume: the CDC feed and warehouse models; they must migrate before the old column is dropped.
- Is there a constant default for `settlement_currency`? → assume: no; it's derived per row.
- Migration tooling? → assume: SQL migrations run by a tool that wraps each file in a transaction unless told not to.
- Off-peak window? → assume: avoid the 1st-5th of the month.

## Design

Every DDL session: `SET lock_timeout = '3s'` and retry with backoff. Each step below is its own deploy.

**A. `settlement_currency NOT NULL`**
1. `ALTER TABLE payments ADD COLUMN settlement_currency char(3);` Nullable, no default: catalog-only. Takes ACCESS EXCLUSIVE for milliseconds.
2. Deploy code that sets it on every insert and update.
3. Backfill in batches by primary key, each batch its own transaction, throttled on replica lag:
```sql
UPDATE payments p SET settlement_currency = m.currency
FROM merchant_accounts m
WHERE m.id = p.merchant_account_id
  AND p.id >= $1 AND p.id < $1 + 5000
  AND p.settlement_currency IS NULL;
```
4. `ALTER TABLE payments ADD CONSTRAINT payments_sc_nn CHECK (settlement_currency IS NOT NULL) NOT VALID;` Brief ACCESS EXCLUSIVE, no scan.
5. `ALTER TABLE payments VALIDATE CONSTRAINT payments_sc_nn;` Full scan under SHARE UPDATE EXCLUSIVE: reads and writes continue.
6. `ALTER TABLE payments ALTER COLUMN settlement_currency SET NOT NULL;` Brief ACCESS EXCLUSIVE; on 12+ it uses the validated CHECK and skips the scan. Then drop the CHECK.

**B. Rename `amount` → `amount_minor` (expand/contract)**
A plain `RENAME COLUMN` is instant, but during a rolling deploy old pods still query `amount` and fail, and CDC consumers break.
1. Add `amount_minor bigint` (nullable). Add a `BEFORE INSERT OR UPDATE` trigger that copies whichever column was set to the other. (`CREATE TRIGGER` takes SHARE ROW EXCLUSIVE briefly.)
2. Backfill in batches, same pattern.
3. Deploy: read `amount_minor`, write both.
4. Move CDC and warehouse models to `amount_minor`.
5. NOT NULL via the CHECK sequence above.
6. Deploy: stop writing `amount`. Drop the trigger, then `ALTER TABLE payments DROP COLUMN amount` (catalog-only; space is reclaimed as rows are rewritten).

Bonus: the new column is `bigint`, which also fixes the integer width of the amount.

## Deep dives

**1. The lock queue.**
Problem: even a catalog-only ALTER needs ACCESS EXCLUSIVE. If a 3-minute report holds ACCESS SHARE, the ALTER waits, and every new query on `payments` queues behind the waiting ALTER: an outage caused by a millisecond operation.
Approach: `lock_timeout` of a few seconds, retry with backoff; check `pg_stat_activity` for long transactions before running; cap reporting queries with `statement_timeout`.
Rejected: "run it at night and hope". Night still has long reports and batch jobs. (Autovacuum is a smaller risk: a non-wraparound autovacuum cancels itself when it blocks a lock request; long user queries don't.)

**2. Backfill mechanics.**
Problem: one `UPDATE` of 200M rows is one transaction: hours of row locks, a WAL burst that lags the replica and CDC, ~200M dead tuples, and no resume point.
Approach: keyset batches of ~5k rows, sleep between batches, pause when replica lag > 5 s, idempotent (`IS NULL` condition) so it can stop and resume. Expect index bloat: tables at default fillfactor 100 get few HOT updates, so most updated rows also get new index entries; plan `REINDEX CONCURRENTLY` (12+) afterwards if needed.

**3. `integer` → `bigint` id (twist).**
Problem: max integer is 2,147,483,647. `ALTER COLUMN id TYPE bigint` rewrites the table and every index under ACCESS EXCLUSIVE: hours of downtime. Every FK column referencing `payments.id` must widen too.
Approach: same expand/contract. Add `id_new bigint`; trigger copies `id`; backfill; NOT NULL via the CHECK sequence; `CREATE UNIQUE INDEX CONCURRENTLY payments_id_new_uq ON payments (id_new)`; widen referencing columns the same way and build their indexes concurrently. Then one short transaction with `lock_timeout`: drop the FKs that depend on the old PK and the old PK itself, `ADD CONSTRAINT payments_pkey PRIMARY KEY USING INDEX payments_id_new_uq`, swap names, `ALTER SEQUENCE payments_id_seq AS bigint OWNED BY payments.id`, set the default. Re-create FKs as `NOT VALID` then `VALIDATE`.
First compute days until exhaustion from the sequence's growth rate: that is the real deadline. If it's too close, an emergency stopgap is restarting the sequence in negative numbers, which works only if no code assumes ids are positive.
Alternative for many FKs: logical replication into a copy of the schema with `bigint` columns, then switchover. More infrastructure, less trigger work.

## Traps

- **No `lock_timeout`**: a metadata-only ALTER blocks all traffic behind a long query.
- **One giant `UPDATE` backfill**.
- **`ADD COLUMN ... DEFAULT gen_random_uuid()` or `clock_timestamp()`**: volatile defaults rewrite the table. Non-volatile defaults (constants, `now()`) are catalog-only since Postgres 11.
- **Rename in the same release as the code change** under rolling deploys.
- **`CREATE INDEX` without `CONCURRENTLY`** (SHARE lock blocks writes), or running `CONCURRENTLY` inside the tool's transaction (not allowed). A failed concurrent build leaves an INVALID index to drop and retry.
- **Assuming `ALTER COLUMN TYPE` is metadata-only**: only binary-compatible changes are (e.g. `varchar(n)` to `text` or a larger `n`); `int` → `bigint` rewrites.

## Say it (60–90 s)

The rule is expand, migrate, contract, with every lock either brief or weak, and lock_timeout on every DDL statement, because even an instant ALTER waits behind a long query and then blocks everything queued after it. For the new column: add it nullable with no default, which is catalog-only. Deploy code that fills it for new rows. Backfill old rows in keyset batches of a few thousand, each its own transaction, throttled on replica lag and resumable because it only touches rows that are still null. Then add a CHECK not-null constraint as NOT VALID, validate it, which scans but allows reads and writes, and SET NOT NULL, which on Postgres twelve and later uses that constraint to skip the scan, then drop the check. The rename can't be a plain rename with rolling deploys and CDC consumers, so I add amount_minor, keep both in sync with a trigger, backfill, switch reads, move the CDC consumers, stop writing the old one, and drop it last. For the integer id at 1.9 billion I first work out how many days are left, then do the same dance with a bigint column and a concurrently built unique index promoted to the primary key, including every referencing foreign key.

## Follow-ups

**Q:** How do you run the backfill safely at peak?
**A:** Throttle on replica lag, CPU and lock waits; pause automatically on the 1st; idempotent batches so pausing costs nothing.

**Q:** Would you use a tool for this?
**A:** pgroll or reshape automate expand/contract with views; I'd still need to know the lock levels to review what they do.

**Q:** What does CDC see during the backfill?
**A:** 200M update events. Warn the warehouse team, or have the consumer filter updates that only touch the new column.

</details>

## Theory in the notes

- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
