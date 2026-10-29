# Schema Design, Zero-Downtime Migrations, Scaling Postgres

---

## 1. Zero-downtime migrations: expand / contract

Rule: during a rolling deploy, **old and new code run at the same time** against the same schema. Every migration has to be compatible with both versions.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`clickhouse/migrate.ts`](../../packages/backend/scripts/clickhouse/migrate.ts): migrate.ts applies ClickHouse SQL migrations in order and records applied files in a schema_migrations table so reruns are idempotent.
> - [`Migration`](../../packages/backend/libs/infrastructure/database/migration.model.ts#L16): The Migration Sequelize model backs the migrations table that tracks which migrations have been applied. _(migration.model.ts)_
<!-- theory-links:end -->

### Renaming a column (`name` → `full_name`)
```
Release 1 (expand):   ADD COLUMN full_name; app writes BOTH, reads old
Backfill:             UPDATE in batches: full_name = name WHERE full_name IS NULL
Release 2:            app reads new, still writes both
Release 3 (contract): app stops writing old
Release 4:            DROP COLUMN name
```
Never rename in a single step. Old pods start failing the moment the migration runs.

### Safe vs dangerous DDL

| Operation | Danger | Safe approach |
|---|---|---|
| `ADD COLUMN` nullable | fast (metadata only) | ✅ |
| `ADD COLUMN ... DEFAULT const` | fast since PG 11 (non-volatile default) | ✅; volatile default (e.g. `random()`) rewrites table |
| `ADD COLUMN NOT NULL` | needs default or fails | add nullable → backfill → constraint |
| `SET NOT NULL` | full scan under ACCESS EXCLUSIVE | `ADD CONSTRAINT c CHECK (col IS NOT NULL) NOT VALID;` → `VALIDATE CONSTRAINT c;` (weaker lock) → `SET NOT NULL` (PG12+ uses the valid check, no scan) → drop check |
| `ADD FOREIGN KEY` | scans + locks both tables | `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` |
| `CREATE INDEX` | blocks writes | `CREATE INDEX CONCURRENTLY` (not in a tx) |
| `ALTER COLUMN TYPE` | table rewrite (except some widenings like varchar(n)→varchar(m>n)/text) | new column + backfill + swap |
| `DROP COLUMN` | fast but breaks old code reading it | stop reading first (and with ORMs, remove from model so `SELECT *`-like queries don't reference it) |

### Always set a lock timeout
```sql
SET lock_timeout = '3s';     -- fail fast instead of queueing everyone behind you
SET statement_timeout = '15min';
ALTER TABLE ...;
```
Wrap it in a retry loop in the migration tool.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RunInTransactionOptions`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L7): RunInTransactionOptions exposes a lock timeout and a statement timeout, and an isolation level, for each transaction. _(transaction-runner.service.ts)_
> - [`TransactionRunner`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L23): TransactionRunner runs work atomically with those lock-timeout options and retries SERIALIZABLE failures. _(transaction-runner.service.ts)_
<!-- theory-links:end -->

### Backfills
- Work in batches by primary-key ranges (`WHERE id BETWEEN x AND x+10000`), each batch committed separately, with sleeps to limit replication lag and vacuum pressure.
- Make them idempotent and resumable (`WHERE new_col IS NULL`).
- Run them as a background job, not inside the migration transaction.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TenancyBackfillJobs`](../../packages/backend/libs/domains/tenancy/infra/tenancy-backfill.jobs.ts#L22): TenancyBackfillJobs is a batch job that backfills Shop ownership and references from legacy seller product data. _(tenancy-backfill.jobs.ts)_
<!-- theory-links:end -->

### Where migrations run
- A separate step before the rollout: a K8s Job or **ArgoCD PreSync hook** / Helm pre-upgrade hook. Not in app startup.
- **Rollback**: a schema rollback is usually *forward fix*. Since expand migrations are backward compatible, rolling back the app is safe without touching the schema.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`clickhouse/migrate.ts`](../../packages/backend/scripts/clickhouse/migrate.ts): Migrations run from a standalone script (scripts/clickhouse/migrate.ts), not at application startup.
<!-- theory-links:end -->

---

## 2. Connection management

- Postgres uses **one OS process per connection** (~5–10 MB each, plus context-switching). `max_connections` is usually in the low hundreds.
- **Pods × pool size** must stay under the limit: 20 pods × pool 20 = 400 connections. Add HPA scaling and you hit `too many connections`.
- **PgBouncer** (or RDS Proxy, or Supavisor):
  - *Session pooling*: client keeps a server connection for the whole session. Little gain.
  - **Transaction pooling**: a server connection is assigned per transaction. Big multiplexing gain. Breaks: session-level `SET`, session advisory locks, `LISTEN/NOTIFY`, temp tables, and (historically) named prepared statements. PgBouncer 1.21+ supports protocol-level prepared statements with `max_prepared_statements`.
- Pool sizing: past a point, more connections make throughput **worse**. A starting formula: `connections ≈ (cores × 2) + effective_spindle_count`. Measure **pool wait time** in the app. If requests wait for a connection while the DB sits idle, the pool is too small. If the DB is saturated, a bigger pool won't help.
- Set `connectionTimeoutMillis` (time to acquire) and `idleTimeoutMillis` on the pool, so requests fail fast instead of hanging.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`DatabaseModule`](../../packages/backend/libs/infrastructure/database/database.module.ts#L36): DatabaseModule exports the configured Sequelize PostgreSQL root connection that the app's pooled connections come from. _(database.module.ts)_
> - [`ReportingPool`](../../packages/backend/libs/domains/statements/infra/reporting-pool.ts#L13): ReportingPool is a dedicated pg pool for exports and reports, kept separate from the main pool. _(reporting-pool.ts)_
<!-- theory-links:end -->

---

## 3. Read replicas

- Streaming replication is async by default, so there's **replication lag**.
- Problem: **read-your-writes**. The user saves and refreshes, the read goes to a replica, and the change is "gone".
  - Fixes: route reads to the primary for N seconds after that user's write (sticky by session); route by required freshness; or compare LSNs (`pg_current_wal_lsn()` on write, wait until the replica's `pg_last_wal_replay_lsn()` ≥ that LSN).
- Long queries on replicas can be cancelled because of replay conflicts (`max_standby_streaming_delay`). `hot_standby_feedback` avoids that but causes bloat on the primary.
- Replicas give **read** scaling. They don't help write throughput.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProjectionCheckpoints`](../../packages/backend/libs/infrastructure/projections/read-your-writes.ts#L19): ProjectionCheckpoints tracks projection versions per aggregate and waits for the read model to catch up, which gives read-your-writes. _(read-your-writes.ts)_
> - [`ReportingPool`](../../packages/backend/libs/domains/statements/infra/reporting-pool.ts#L13): ReportingPool supports read replica routing for report queries. _(reporting-pool.ts)_
<!-- theory-links:end -->

---

## 4. Partitioning

Declarative partitioning (range, list, or hash):
```sql
CREATE TABLE events (id bigint, tenant_id int, created_at timestamptz NOT NULL, payload jsonb)
PARTITION BY RANGE (created_at);
CREATE TABLE events_2026_10 PARTITION OF events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
```
How it works:
- The `PARTITION BY` table (`events`) is a **parent that stores no rows**. It defines the columns and the routing rule. `RANGE (created_at)` means each child owns a range of `created_at` values (`FROM` inclusive, `TO` exclusive); `LIST` = explicit values; `HASH` = `hash % N`.
- `CREATE TABLE child PARTITION OF parent FOR VALUES …` creates a **real table** attached to the parent for that range.
- `INSERT INTO events` → Postgres routes each row to the child whose range contains it. No matching child → the insert **fails** (unless a `DEFAULT` partition exists), so create partitions **ahead of time**.
- `SELECT … FROM events WHERE created_at > …` → reads only the matching children (**partition pruning**). Without a filter on the partition key, it reads all of them.
- `DETACH PARTITION child` unhooks a child: it becomes a normal standalone table, invisible through the parent. Then `DROP` it, or archive it. `DETACH … CONCURRENTLY` (PG14+) avoids holding a strong lock on the parent while running; it can't run inside a transaction block. Plain `DROP TABLE child` also works but locks the parent briefly.

Benefits:
- **Partition pruning**: queries filtering on `created_at` touch only the relevant partitions.
- **Retention**: `DROP TABLE events_2025_01` (or `DETACH ... CONCURRENTLY`) instead of a massive `DELETE` that bloats the table. `DROP` deletes the partition's files; `DELETE` marks every row dead one by one, writes them all to WAL, and leaves bloat for vacuum.
- **Rotation job** (daily): create the next partitions ahead; roll the oldest one up into a summary table if you need it (`INSERT … SELECT … GROUP BY`); detach and drop it. Run it with **pg_cron** (extension that runs SQL on a schedule inside Postgres, e.g. `SELECT cron.schedule('rotate', '15 0 * * *', $$CALL rotate_partitions()$$)`, where the procedure builds the dated table names with `format()` + `EXECUTE`), from an app-side scheduler, or let **pg_partman** create and drop partitions from a config (`premake`, retention); any roll-up before dropping stays your job. Both extensions are available on RDS/Aurora.
- Smaller indexes per partition, and vacuum works per partition.

Costs: primary and unique keys must include the partition key; you have to automate partition creation (`pg_partman`); and **too many partitions** (thousands) backfire:
| Cost | Why |
|---|---|
| Slower planning | the planner considers every partition the query might touch; pruning helps only when the query filters on the partition key |
| Lock overhead | a query locks every partition it touches; past 16 relations per transaction Postgres leaves the fast-path lock slots for the shared lock table → contention |
| Memory | each backend caches metadata for every partition it opens; × hundreds of connections |
| Migrations | `ALTER TABLE` / new index runs on every partition |
| Cross-partition queries | "everything received in the last hour, all customers" scans thousands of partitions |
Rules of thumb: tens to low hundreds of partitions; partition by **time** (retention) or by a key nearly every query filters on. **Per-customer partitions are an anti-pattern**: use a `tenant_id` column + composite indexes leading with it, or `PARTITION BY HASH (tenant_id)` into a fixed small number (e.g. 16).

Rule of thumb: consider it once a table goes past roughly 100 GB, or when you have a clear time-based retention requirement.

### Worked example: rolling per-day partitions (click counts, URL shortener)
Three time units, don't mix them up: the **row** counts one minute bucket (`minute` = `date_trunc('minute', ts)`); each **partition** holds one day of those rows (for cheap deletion); `click_rollups_daily` keeps per-day totals forever. Tested on Postgres 16/17 (PGlite).

```sql
-- ============ 1. Tables ============

-- Live per-minute counts. Parent table: stores no rows itself, routes them to per-day children.
CREATE TABLE click_rollups_minute (
  code     text        NOT NULL,
  minute   timestamptz NOT NULL           -- start of the minute bucket, e.g. 10:01:00
           CHECK (minute = date_trunc('minute', minute)),   -- reject 10:01:12 at write time
  country  char(2)     NOT NULL,
  device   text        NOT NULL,          -- mobile | desktop | tablet | other
  clicks   bigint      NOT NULL CHECK (clicks >= 0),
  PRIMARY KEY (code, minute, country, device)   -- must contain the partition key (minute)
) PARTITION BY RANGE (minute);

-- Long-term per-day totals. Small enough to keep forever.
CREATE TABLE click_rollups_daily (
  code     text    NOT NULL,
  day      date    NOT NULL,
  country  char(2) NOT NULL,
  device   text    NOT NULL,
  clicks   bigint  NOT NULL,
  PRIMARY KEY (code, day, country, device)
);

-- Where the stream consumer stopped, per Kinesis shard (exactly-once effect).
CREATE TABLE stream_checkpoints (
  shard_id  text PRIMARY KEY,
  last_seq  numeric NOT NULL             -- Kinesis sequence numbers are big integers
);

-- ============ 2. Partition maintenance ============

-- Create the child table for one day, if it doesn't exist yet.
CREATE OR REPLACE FUNCTION create_minute_partition(d date) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF click_rollups_minute FOR VALUES FROM (%L) TO (%L)',
    'click_rollups_minute_' || to_char(d, 'YYYY_MM_DD'),
    d::timestamptz, (d + 1)::timestamptz);
END $$;

-- Daily job: create the next 7 days, roll up and drop days older than 3 days.
CREATE OR REPLACE FUNCTION rotate_click_partitions(today date DEFAULT current_date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  d    date;
  part text;
BEGIN
  -- 1. create ahead: inserts fail if no partition covers the row
  FOR i IN 0..7 LOOP
    PERFORM create_minute_partition(today + i);
  END LOOP;

  -- 2. every partition older than the 3-day window: roll up, then drop
  FOR part, d IN
    SELECT c.relname, to_date(right(c.relname, 10), 'YYYY_MM_DD')
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'click_rollups_minute'::regclass
      AND to_date(right(c.relname, 10), 'YYYY_MM_DD') < today - 3
  LOOP
    EXECUTE format(
      'INSERT INTO click_rollups_daily (code, day, country, device, clicks)
       SELECT code, %L::date, country, device, sum(clicks) FROM %I GROUP BY code, country, device
       ON CONFLICT (code, day, country, device) DO UPDATE SET clicks = EXCLUDED.clicks',
      d, part);
    EXECUTE format('ALTER TABLE click_rollups_minute DETACH PARTITION %I', part);
    EXECUTE format('DROP TABLE %I', part);
  END LOOP;
END $$;
```

Writing (the stream consumer, one transaction per batch: upserts + checkpoint, so a redelivered batch is skipped):
```sql
INSERT INTO click_rollups_minute (code, minute, country, device, clicks)
VALUES ('aB3x9Kq', date_trunc('minute', '2026-10-24T10:01:12Z'::timestamptz), 'PL', 'mobile', 350)
ON CONFLICT (code, minute, country, device)
DO UPDATE SET clicks = click_rollups_minute.clicks + EXCLUDED.clicks;   -- lands in click_rollups_minute_2026_10_24
```

Schedule: `SELECT cron.schedule('rotate-clicks', '15 0 * * *', $$SELECT rotate_click_partitions()$$);` (pg_cron).

**Why partitions aren't created automatically:** Postgres routes an insert only to a partition that **already exists**; it never creates one on the fly. A row with no matching partition fails (`no partition of relation … found for row`). A `DEFAULT` partition would catch it, but then rows pile up there, and attaching the proper partition later means Postgres must scan the default for overlapping rows and you must move them yourself. So: create partitions **ahead** (here 7 days) with a job or pg_partman, and alert if the job stops.

Details:
- **Minute precision**: Postgres has no "minute" type. `timestamptz` + a `CHECK (minute = date_trunc('minute', minute))` rejects a non-truncated value at write time, so a bug can't silently create a second row for the same minute. Alternative: `bigint` epoch minutes (`CHECK (minute_epoch % 60 = 0)` if in seconds): compact, but you lose readable SQL and date functions.
- Run the DB/session in UTC: `d::timestamptz` uses the session time zone for the day boundaries.
- Roll-up uses `SET clicks = EXCLUDED.clicks` (overwrite, not add), so re-running the job after a crash gives the same totals.
- `DETACH … CONCURRENTLY` can't run inside a function/transaction; the function uses plain `DETACH` (brief lock on the parent). For zero blocking, run `DETACH … CONCURRENTLY` and `DROP` as separate statements from the scheduler.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LedgerMaintenanceJobs`](../../packages/backend/libs/domains/payments/infra/ledger-maintenance.jobs.ts#L16): LedgerMaintenanceJobs pre-creates the monthly ledger partitions and runs the invariant verification. _(ledger-maintenance.jobs.ts)_ · [Ledger partitions and invariant checks](../../docs/humans/concepts/domain-payments/ledger-maintenance.md)
> - [`JobMaintenance`](../../packages/backend/libs/infrastructure/jobs/job-maintenance.service.ts#L25): JobMaintenance handles partition maintenance for the jobs infrastructure. _(job-maintenance.service.ts)_
<!-- theory-links:end -->

---

## 5. Sharding

- Split data across multiple PG clusters by a shard key (usually `tenant_id`).
- Options: application-level routing, **Citus** (distributed Postgres), or managed products.
- Hard parts: cross-shard queries and transactions, rebalancing, global uniqueness (use UUIDv7 or Snowflake IDs), and choosing a key that avoids hot shards.
- Senior answer: **exhaust the alternatives first**: indexes, query fixes, caching, replicas, partitioning, vertical scaling (big instances go a long way), archiving, and moving analytics to a warehouse.

---

## 6. IDs

| Type | Pros | Cons |
|---|---|---|
| `bigint identity` | compact, fast, ordered | enumerable (IDOR risk if exposed), needs coordination across shards |
| UUIDv4 | global, unguessable | random → B-tree page splits, poor locality, 16 bytes |
| **UUIDv7** | time-ordered + global; good index locality | leaks creation time; PG 18 has native `uuidv7()` |
| ULID / Snowflake | ordered, compact | custom |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Hand out ids in blocks of 1,000 from Redis](../../docs/humans/concepts/domain-marketing/id-lease.md): IdLease hands out link IDs in blocks of 1,000 from Redis, so the database is not hit for every ID. [`IdLease`](../../packages/backend/libs/domains/marketing/infra/id-lease.ts#L9)
> - [`uuidv7`](../../packages/backend/scripts/load-tests/lib/utils.js#L14): The uuidv7 helper generates time-ordered UUIDv7 values with a 48-bit millisecond timestamp. _(utils.js)_
<!-- theory-links:end -->

---

## 7. Temporal data / as-of reporting

Patterns for reconstructing data as it was at any past date (audits, historical reports):

### SCD Type 2 (slowly changing dimension) / valid-time tables
```sql
CREATE TABLE product_prices (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL,
  price_list_id bigint NOT NULL,
  price_cents bigint NOT NULL,
  valid tstzrange NOT NULL,           -- [from, to)
  EXCLUDE USING gist (product_id WITH =, price_list_id WITH =, valid WITH &&)   -- no overlapping versions per product and list
);
-- "As of" query:
SELECT * FROM product_prices WHERE product_id = $1 AND price_list_id = $2 AND valid @> $asOf::timestamptz;
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CommissionRateService`](../../packages/backend/libs/domains/statements/application/commission-rate.service.ts#L34): CommissionRateService manages bitemporal commission rates through setRate, rateAsOf and history queries. _(commission-rate.service.ts)_
> - [`RateRow`](../../packages/backend/libs/domains/statements/application/commission-rate.service.ts#L14): RateRow models a commission rate record with temporal periods. _(commission-rate.service.ts)_
<!-- theory-links:end -->

### Bitemporal modeling
- **Valid time**: when the fact was true in the real world (the price changed on Mar 1).
- **Transaction time**: when *we recorded* it (we learned about it on Mar 15).
- Audits need both: "what did the report for Q1 look like **as we knew it on Apr 1**" vs "what *should* Q1 have been given corrections made later?"
- Implementation: two ranges (`valid`, `recorded`), never UPDATE in place. Close the current version (`recorded = [t0, now)`) and insert a new one.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StatementService`](../../packages/backend/libs/domains/statements/application/statement.service.ts#L33): StatementService computes seller statements using bitemporal rate lookups and handles retroactive adjustments. _(statement.service.ts)_
> - [`CommissionRateService`](../../packages/backend/libs/domains/statements/application/commission-rate.service.ts#L34): CommissionRateService keeps both valid time and recorded time for rates so past statements can be reproduced. _(commission-rate.service.ts)_
<!-- theory-links:end -->

### Alternatives
- **Event sourcing**: store events and rebuild state as of any point. Powerful, but a heavy paradigm.
- **Audit/history tables** filled by triggers (`*_history` with `operation`, `changed_at`, `changed_by`).
- **Snapshots**: materialize monthly closing states for fast reporting, plus deltas.

Performance: GiST indexes on ranges, partitioning by period, and materialized views for frequently queried periods (`REFRESH MATERIALIZED VIEW CONCURRENTLY`, which needs a unique index).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LeaderboardSnapshotJobs`](../../packages/backend/libs/domains/seller-insights/infra/leaderboard-snapshot.jobs.ts#L25): LeaderboardSnapshotJobs snapshots the top-100 leaderboard on a schedule, which is the snapshot approach to historical reporting. _(leaderboard-snapshot.jobs.ts)_
<!-- theory-links:end -->

---

## 8. Schema design topics

- **Normalization** to 3NF for OLTP. Denormalize deliberately for read paths (counters, materialized views, read models), with a clear owner for keeping them in sync.
- **Constraints are your last line of defense**: `NOT NULL`, `CHECK (amount_cents > 0)`, `UNIQUE`, FKs, exclusion constraints. App validation can be bypassed (scripts, bugs, races). Constraints can't.
- **JSONB**: good for truly variable attributes, external payload storage, and settings. Bad for fields you filter, join, or constrain on regularly. Promote those to columns. GIN on `jsonb_path_ops` for `@>` queries.
- **Soft deletes** (`deleted_at`): every query must filter on it, unique indexes need to be partial, and GDPR may require hard deletes anyway. Alternative: move deleted rows to an archive table.
- **Multi-tenancy**: shared tables with `tenant_id` (+ RLS), schema per tenant (migrations become N× more work), or DB per tenant (strong isolation, expensive). Most SaaS products use shared tables + `tenant_id` + composite indexes that lead with `tenant_id`.
- **Enums**: PG `ENUM` types (adding values is easy, removing is hard), a lookup table, or text + CHECK.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Immutable rows: once written, never updated or deleted](../../docs/humans/concepts/domain-payments/ledger-immutability.md): The LedgerEntry model disables updatedAt and deletedAt, so entries are immutable once inserted. [`LedgerEntry`](../../packages/backend/libs/domains/payments/infra/models/ledger-entry.model.ts#L79)
> - [Payout row with one-per-shop-per-week rule](../../docs/humans/concepts/domain-payments/payout-model.md): The Payout table has a unique constraint of one payout per shop per week, enforced in the database. [`Payout`](../../packages/backend/libs/domains/payments/infra/models/payout.model.ts#L4)
<!-- theory-links:end -->

---

## 9. CDC (Change Data Capture)

- Logical replication / **Debezium** reads the WAL and publishes row changes to Kafka.
- Use cases: syncing a search index, a cache, a warehouse, or a legacy system (e.g. during a migration away from it); a reliable outbox relay.
- Beats dual writes (app writes to the DB *and* publishes an event, and one of them fails).
- Watch out for: replication slots **retain WAL** while the consumer is down, and the disk fills up. Monitor slot lag (`pg_replication_slots`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OutboxPublisherService`](../../packages/backend/libs/infrastructure/outbox/outbox-publisher.service.ts#L27): OutboxPublisherService drains unpublished outbox rows to Kafka with retries and leasing, which avoids dual writes. _(outbox-publisher.service.ts)_
> - [`ProjectionRunner`](../../packages/backend/libs/infrastructure/projections/projection-runner.service.ts#L26): ProjectionRunner consumes Kafka events to build projections, with retries, backpressure and lag metrics. _(projection-runner.service.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you add a NOT NULL column to a large hot table without downtime?**
Add it nullable (with a constant default if needed; that's metadata-only on PG11+), deploy code that writes it, backfill in batches, add `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE` it, then `SET NOT NULL` (no scan thanks to the validated check) and drop the check. Use `lock_timeout` on every step.

**Q: We have 30 pods and get "too many connections". What do you do?**
Calculate pods × pool size, add PgBouncer in transaction mode or RDS Proxy, size pools from measured pool wait times, and make sure no code depends on session state. Also find and fix leaked connections (clients not released) and long transactions.

**Q: How would you implement "as-of" historical reporting?**
Valid-time ranges with exclusion constraints (or bitemporal valid + recorded ranges), insert-only versioning, as-of queries using `@>`, GiST indexes, plus periodic snapshots/materialized views for performance.
