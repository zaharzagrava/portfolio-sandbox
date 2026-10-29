# arch-28. Zero-downtime schema change on a 200M-row table

*Data · Hard*

## The question

"`shipments` has 200M rows and takes 2-3k writes/s at peak from tracking updates. We need to add `origin_country char(2) NOT NULL`, backfilled per row from the shipment's warehouse (another table), and replace `weight numeric` (kilograms) with `weight_grams integer`. Postgres 15 on RDS, Node services with rolling deploys, one read replica and a CDC feed to the warehouse. No downtime, no long locks. Walk me through it."

**Then:** "The `id` column is `integer`, and its sequence is at 1.9 billion, even though the table has only 200M rows. Why, and what now?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Postgres version? → assume: 15. It decides what is metadata-only: fast non-volatile defaults (11+), `SET NOT NULL` skipping the scan when a valid CHECK proves it (12+), `NOT NULL ... NOT VALID` directly (18+).
- Long-running queries on this table? → assume: reporting queries of several minutes on the primary. They're why a "fast" ALTER can still cause an outage.
- Who reads `weight` outside this service? → assume: the CDC feed and warehouse models; they must migrate before the old column is dropped.
- Is there a constant default for `origin_country`? → assume: no; it's derived per row.
- Migration tooling? → assume: SQL migrations run by a tool that wraps each file in a transaction unless told not to.
- Peak periods? → assume: avoid the November-December shipping peak and the daily 17:00-21:00 window.

## Design

Every DDL session: `SET lock_timeout = '3s'`, retry with backoff. Each step is its own deploy.

**A. `origin_country NOT NULL`**
1. `ALTER TABLE shipments ADD COLUMN origin_country char(2);` Nullable, no default: catalog-only, ACCESS EXCLUSIVE for milliseconds.
2. Deploy code that sets it on every insert and update.
3. Backfill in keyset batches, each its own transaction, throttled on replica lag:
```sql
UPDATE shipments s SET origin_country = w.country
FROM warehouses w
WHERE w.id = s.warehouse_id
  AND s.id >= $1 AND s.id < $1 + 5000
  AND s.origin_country IS NULL;
```
4. `ALTER TABLE shipments ADD CONSTRAINT shipments_oc_nn CHECK (origin_country IS NOT NULL) NOT VALID;` Brief lock, no scan.
5. `ALTER TABLE shipments VALIDATE CONSTRAINT shipments_oc_nn;` Full scan under SHARE UPDATE EXCLUSIVE: reads and writes continue.
6. `ALTER TABLE shipments ALTER COLUMN origin_country SET NOT NULL;` Brief lock; on 12+ the validated CHECK lets it skip the scan. Drop the CHECK.

**B. `weight` → `weight_grams` (expand/contract)**
A rename plus a unit change can't be one step: during a rolling deploy old pods still read and write `weight`, and CDC consumers break.
1. Add `weight_grams integer` (nullable). Add a `BEFORE INSERT OR UPDATE` trigger: if only `weight` changed, set `weight_grams = round(weight * 1000)`; if only `weight_grams` changed, set `weight = weight_grams / 1000.0`. (`CREATE TRIGGER` takes SHARE ROW EXCLUSIVE briefly.)
2. Backfill in batches, same pattern.
3. Deploy: read `weight_grams`, write both.
4. Move CDC and warehouse models to `weight_grams`.
5. NOT NULL via the CHECK sequence above.
6. Deploy: stop writing `weight`. Drop the trigger, then `DROP COLUMN weight` (catalog-only; space comes back as rows are rewritten).

## Deep dives

**1. The lock queue.**
Problem: even a catalog-only ALTER needs ACCESS EXCLUSIVE. If a 3-minute report holds ACCESS SHARE, the ALTER waits, and every new query on `shipments` queues behind the waiting ALTER: an outage caused by a millisecond operation.
Approach: `lock_timeout` of a few seconds with retries; check `pg_stat_activity` for long transactions first; cap reporting with `statement_timeout`.
Rejected: "run it at night and hope". Nights still have batch jobs. (A non-wraparound autovacuum cancels itself when it blocks a lock request; long user queries don't.)

**2. Backfill mechanics.**
Problem: one `UPDATE` of 200M rows is one transaction: hours of row locks, a WAL burst that lags the replica and CDC, ~200M dead tuples, no resume point.
Approach: keyset batches of ~5k, sleep between batches, pause when replica lag > 5 s, idempotent through the `IS NULL` condition so it can stop and resume. Expect index bloat: at default fillfactor 100 few updates are HOT, so most rows get new index entries; plan `REINDEX CONCURRENTLY` (12+) if needed.

**3. `integer` → `bigint` id (twist).**
Why the gap: `INSERT ... ON CONFLICT DO UPDATE` calls `nextval` before it detects the conflict, so every tracking upsert burns an id. So do rolled-back inserts. Max integer is 2,147,483,647; measure the burn rate from `pg_sequences.last_value` a day apart. At ~15M ids/day, ~247M left is about 16 days: that's the deadline.
`ALTER COLUMN id TYPE bigint` rewrites the table and every index under ACCESS EXCLUSIVE: hours of downtime. Instead: add `id_new bigint`, a trigger copies `id`, backfill, NOT NULL via CHECK, `CREATE UNIQUE INDEX CONCURRENTLY shipments_id_new_uq ON shipments (id_new)`, and widen every referencing FK column the same way. Then one short transaction with `lock_timeout`: drop dependent FKs and the old PK, `ADD CONSTRAINT shipments_pkey PRIMARY KEY USING INDEX shipments_id_new_uq`, swap names, `ALTER SEQUENCE shipments_id_seq AS bigint OWNED BY shipments.id`, set the default. Re-create FKs `NOT VALID`, then `VALIDATE`.
Stopgap if the deadline is too close: restart the sequence at negative numbers, only if no code assumes ids are positive. Also stop burning ids: check existence before upserting hot paths.

## Traps

- **No `lock_timeout`**: a metadata-only ALTER blocks all traffic behind a long query.
- **One giant `UPDATE` backfill**.
- **`ADD COLUMN ... DEFAULT gen_random_uuid()` or `clock_timestamp()`**: volatile defaults rewrite the table. Non-volatile defaults (constants, `now()`) are catalog-only since Postgres 11.
- **Rename or unit change in the same release as the code change** under rolling deploys.
- **`CREATE INDEX` without `CONCURRENTLY`** (its SHARE lock blocks writes), or `CONCURRENTLY` inside the tool's transaction (not allowed). A failed concurrent build leaves an INVALID index to drop and retry.
- **Assuming `ALTER COLUMN TYPE` is metadata-only**: only binary-compatible changes are (e.g. `varchar(n)` to `text`); `integer` → `bigint` rewrites.

## Say it (60–90 s)

The rule is expand, migrate, contract, with every lock either brief or weak, and lock_timeout on every DDL statement, because even an instant ALTER waits behind a long query and then blocks everything queued after it. For the new column: add it nullable with no default, which is catalog-only. Deploy code that fills it for new rows. Backfill old rows in keyset batches of a few thousand, each its own transaction, throttled on replica lag and resumable because it only touches rows that are still null. Then add a CHECK not-null constraint as NOT VALID, validate it, which scans but allows reads and writes, and SET NOT NULL, which on Postgres twelve and later uses that constraint to skip the scan. The weight change can't be a plain rename with rolling deploys and a CDC feed, so I add weight_grams, keep both columns in sync with a trigger that converts units, backfill, switch reads, move the CDC consumers, stop writing the old column, and drop it last. For the id at 1.9 billion: upserts burn sequence values, which explains the gap. I compute the days left from the burn rate, then do the same dance with a bigint column and a concurrently built unique index promoted to the primary key, including every referencing foreign key.

## Follow-ups

**Q:** How do you run the backfill safely during the daily peak?
**A:** Throttle on replica lag, CPU and lock waits; pause automatically during the 17:00-21:00 window; idempotent batches so pausing costs nothing.

**Q:** Would you use a tool for this?
**A:** pgroll or Reshape automate expand/contract with views and triggers; I'd still need to know the lock levels to review what they do.

**Q:** What does the CDC feed see during the backfill?
**A:** 200M update events per backfill. Warn the warehouse team, or have the consumer skip updates that only touch the new column.

</details>

## Theory in the notes

- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
