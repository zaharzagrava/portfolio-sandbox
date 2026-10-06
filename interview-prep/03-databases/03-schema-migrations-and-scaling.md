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
Benefits:
- **Partition pruning**: queries filtering on `created_at` touch only the relevant partitions.
- **Retention**: `DROP TABLE events_2025_01` (or `DETACH ... CONCURRENTLY`) instead of a massive `DELETE` that bloats the table.
- Smaller indexes per partition, and vacuum works per partition.

Costs: primary and unique keys must include the partition key; too many partitions (thousands) slow planning; you have to automate partition creation (`pg_partman`).

Rule of thumb: consider it once a table goes past roughly 100 GB, or when you have a clear time-based retention requirement.

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
