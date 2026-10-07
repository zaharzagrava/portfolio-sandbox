# Transactions, Isolation, MVCC, Locking (PostgreSQL)

How Postgres keeps data consistent under concurrency: MVCC, VACUUM, isolation levels, anomalies, and locking.

---

## 1. MVCC and VACUUM in Postgres

**MVCC (multi-version concurrency control)**: instead of overwriting a row in place, Postgres keeps **several versions** of it and shows each transaction the version that was valid at the moment it started looking. Readers never block writers, and writers never block readers. The price is that old versions pile up, and **VACUUM** has to clean them up.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TransactionRunner`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L23): TransactionRunner wraps work in atomic DB transactions with isolation level options and SERIALIZABLE retry, the MVCC-based concurrency control the section describes. _(transaction-runner.service.ts)_
<!-- theory-links:end -->

### 1.1 Row versions and snapshots
Every row version (a *tuple*) in a table carries two hidden fields:
- **`xmin`**: the ID of the transaction that **created** this version;
- **`xmax`**: the ID of the transaction that **deleted or replaced** it (empty while the version is current).

Every statement (Read Committed) or transaction (Repeatable Read and Serializable) works with a **snapshot**: the list of transactions that had committed when it started. A version is visible to you if:
- its `xmin` transaction committed **before** your snapshot, and
- its `xmax` is empty, or belongs to a transaction that hadn't committed by your snapshot (or rolled back).

Transaction IDs are 32-bit counters, assigned to every transaction that writes.

### 1.2 What each statement does to the table and the indexes

| Statement | Table (heap) | Indexes |
|---|---|---|
| `INSERT` | adds a new version: `xmin` = my transaction | adds an entry in **every** index, pointing to the new version |
| `UPDATE` | sets `xmax` = my transaction on the old version, and writes a **new version** (usually at a new location) with `xmin` = my transaction | adds entries for the new version in every index; old entries stay. Exception, **HOT update** (§1.6): no index changes |
| `DELETE` | sets `xmax` = my transaction on the version; the row physically stays | **no change** |
| `ROLLBACK` | nothing is undone physically: versions created by the aborted transaction just count as never committed (dead), and the `xmax` marks it set are ignored | no change |
| `SELECT` | reads versions and keeps only the ones visible to its snapshot | finds candidate entries; visibility is checked on the table row (or skipped via the visibility map for index-only scans; indexing doc §3.2) |

Example: two transactions, one row.

```
balance row, version V1 {balance 100, xmin=90}

T1 (id 100): BEGIN; UPDATE accounts SET balance = 50 WHERE id = 1;
   table: V1 {100, xmin=90, xmax=100}    V2 {50, xmin=100}
   index on id: (1) → V1,  (1) → V2

T2 (reader, snapshot taken before T1 commits): SELECT balance ... → sees V1 = 100
   (V2's creator hasn't committed; V1's deleter hasn't committed)  — T2 is not blocked

T1: COMMIT
T3 (new snapshot): SELECT balance ... → sees V2 = 50  (V1 is now replaced)

V1 is now dead: no new snapshot will ever see it. It still occupies space in the table and in the index.
```

**CRITICAL RULE: Writers block writers.**
MVCC removes reader/writer blocking (readers don't block writers, and writers don't block readers). But **writers always block writers** updating the *same* row.
Example:
- Transaction 1 (T1) runs: `UPDATE orders SET status = 'PROCESSING' WHERE id = 1;`
- Transaction 2 (T2) runs: `UPDATE orders SET status = 'CANCELLED' WHERE id = 1;`
Even under the default, less-strict **Read Committed** isolation, T2 will instantly **block and wait** until T1 either `COMMIT`s or `ROLLBACK`s. 
If T1 commits, T2 wakes up, re-evaluates its `WHERE` clause against T1's newly committed row version, and applies its update (if the WHERE clause still matches). This is why long-running transactions (or Two-Phase Commit) that hold write-locks are so dangerous for database concurrency.

### 1.3 Dead tuples and why they're a problem
A version is **dead** when no current or future snapshot can see it: replaced by a committed UPDATE, deleted by a committed DELETE, or created by a rolled-back transaction. Dead tuples:
- take space in table pages and index pages (**bloat**), so scans read more pages for the same live data;
- keep their index entries, so index scans follow pointers to rows that turn out to be invisible;
- clear visibility-map bits, so index-only scans need heap fetches.

Some cleanup happens on the fly: when a query visits a page, Postgres can prune dead versions inside that page, and index scans mark entries of dead rows so later scans skip them. Full cleanup, including index entries, is VACUUM's job.

### 1.4 VACUUM: what it does
VACUUM processes a table and:
1. **Finds dead tuples** that no running transaction can still see. It can only remove versions older than the **xmin horizon**: the oldest snapshot still in use anywhere in the database.
2. **Removes their index entries**, by scanning each index of the table.
3. **Frees their space in the table pages**, so new rows and updates can reuse it. The file usually doesn't shrink (only empty pages at the very end are returned to the OS); the space is reused.
4. **Updates the visibility map**: marks pages whose rows are all visible to everyone (*all-visible*, used by index-only scans) and whose rows are old enough to be frozen (*all-frozen*). This is why VACUUM matters for insert-only tables too.
5. **Freezes old rows**: replaces very old `xmin` values with a "frozen, visible to everyone" marker. Transaction IDs are 32-bit and wrap around after about 2 billion. Without freezing, old rows would suddenly look like they came from the future and disappear. If freezing falls too far behind, Postgres stops accepting writes to protect the data.
6. **Updates the free space map**, so inserts know which pages have room.

What it doesn't do:
- It doesn't block normal work. Plain `VACUUM` takes a lock that allows SELECT, INSERT, UPDATE, and DELETE to continue; it only conflicts with DDL and with another VACUUM on the same table.
- It doesn't shrink files. **`VACUUM FULL`** rewrites the table compactly and returns space to the OS, but takes an **exclusive lock** (blocks reads and writes for the whole rewrite). Avoid it in production; use `pg_repack` for online compaction.
- It doesn't collect planner statistics. That's **`ANALYZE`** (often run together: `VACUUM ANALYZE`; indexing doc §4.6).

### 1.5 Autovacuum
A background launcher starts worker processes that VACUUM and ANALYZE tables automatically when they cross thresholds:

| Trigger | Default rule |
|---|---|
| vacuum after updates/deletes | dead tuples > 50 + **20%** of the table's rows |
| vacuum after inserts (PG 13+) | inserted rows > 1000 + 20% of rows (sets visibility bits, freezes) |
| analyze | changed rows > 50 + 10% of rows |
| anti-wraparound vacuum | oldest unfrozen transaction ID older than 200M (`autovacuum_freeze_max_age`); runs even if autovacuum is "off" |

Tuning points:
- **20% is too much for big tables**: a 500M-row table waits for 100M dead rows. Lower it per table: `ALTER TABLE events SET (autovacuum_vacuum_scale_factor = 0.01);` (or use a fixed threshold).
- Autovacuum is **throttled** (cost limit / cost delay) so it doesn't hurt foreground queries. On busy databases with fast disks, raise `autovacuum_vacuum_cost_limit` and the number of workers, or it never catches up.
- Monitor: `n_dead_tup`, `last_autovacuum`, `last_autoanalyze` in `pg_stat_user_tables`; running vacuums in `pg_stat_progress_vacuum`; wraparound risk with `age(datfrozenxid)` per database.

### 1.6 HOT updates
A **heap-only tuple (HOT) update** happens when the UPDATE **doesn't change any indexed column** and the new version **fits on the same page**. Then no index entry is added: the index keeps pointing to the old version, which links to the new one within the page. The old version can be pruned on the fly without VACUUM touching indexes.
- Avoid indexing columns that change constantly (like `updated_at`), or every update becomes a full non-HOT update.
- Leave free space on update-heavy tables with `fillfactor` (e.g. `ALTER TABLE accounts SET (fillfactor = 85)`), so new versions fit on the same page.
- `n_tup_hot_upd` vs `n_tup_upd` in `pg_stat_user_tables` shows the HOT ratio.

### 1.7 What stops VACUUM from cleaning up
VACUUM can't remove a dead version while **any** snapshot might still need it. Anything that keeps an old snapshot alive holds back the xmin horizon **for the whole database**, so bloat grows on every table:
- **long-running transactions**: analytics queries on the primary, batch jobs in one giant transaction;
- **`idle in transaction` sessions**: an app opened a transaction and never committed (forgotten `COMMIT`, a crashed worker holding a pooled connection);
- **replication slots** whose consumer stopped (a CDC tool like Debezium that's down), and replicas with `hot_standby_feedback = on` running long queries;
- forgotten **prepared transactions** (two-phase commit).

Guards and checks:

```sql
-- oldest open transactions
SELECT pid, state, now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start
LIMIT 5;
```

- `idle_in_transaction_session_timeout` (e.g. 60 s) and `statement_timeout` per role.
- Run long analytics on a replica or a warehouse, not the primary.
- Alert on old transactions (> 15 min) and on replication slot lag (`pg_replication_slots`).

---

## 2. Anomalies

| Anomaly | Description |
|---|---|
| Dirty read | read uncommitted data of another tx |
| Non-repeatable read | same row read twice gives different values |
| Phantom read | same predicate query returns different set of rows |
| **Lost update** | two tx read-modify-write the same row; one overwrite is lost |
| **Write skew** | two tx read overlapping data, write *different* rows, each valid alone but together violate an invariant (e.g., "at least one doctor on call") |
| Read skew | seeing parts of the DB at different points in time (e.g., transfer between accounts looks like money vanished) |

---

## 3. Isolation levels in Postgres

| Level | PG behavior | Prevents | Still possible |
|---|---|---|---|
| Read Uncommitted | = Read Committed in PG | dirty reads | — |
| **Read Committed** (default) | new snapshot **per statement** | dirty reads | non-repeatable, phantoms, lost updates (with read-then-write in app), write skew |
| **Repeatable Read** | one snapshot **per transaction** (snapshot isolation) | + non-repeatable, phantoms (PG is stronger than the SQL standard here), lost update → raises `40001 could not serialize` | **write skew** |
| **Serializable** | SSI: snapshot isolation + detecting dangerous read/write dependency cycles | everything; behaves as if serial | must **retry on 40001** |

**Serializable and Repeatable Read require retry logic.** Example:
```ts
async function withSerializableRetry<T>(fn: (tx: Tx) => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await db.transaction({ isolationLevel: 'SERIALIZABLE' }, fn);
    } catch (e: any) {
      if ((e.code === '40001' || e.code === '40P01') && i < attempts) {      // serialization failure / deadlock
        await sleep(2 ** i * 10 + Math.random() * 50);
        continue;
      }
      throw e;
    }
  }
}
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`RunInTransactionOptions`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L7): RunInTransactionOptions exposes the isolation level, lock timeout and statement timeout a transaction can request. _(transaction-runner.service.ts)_
> - [`TransactionRunner`](../../packages/backend/libs/infrastructure/context/transaction-runner.service.ts#L23): TransactionRunner runs transactions at a chosen isolation level and retries SERIALIZABLE failures. _(transaction-runner.service.ts)_
<!-- theory-links:end -->

---

## 4. Preventing lost updates: four techniques

Scenario: two requests both withdraw from a balance of 100 at the same time.

```sql
-- ❌ Read-modify-write in application (Read Committed) → lost update
SELECT balance FROM accounts WHERE id = 1;     -- both read 100
UPDATE accounts SET balance = 70 WHERE id = 1; -- both write their own computed value
```

1. **Atomic update** (best when possible):
   ```sql
   UPDATE accounts SET balance = balance - 30 WHERE id = 1 AND balance >= 30 RETURNING balance;
   -- 0 rows → insufficient funds. The row lock serializes concurrent updates; RC re-evaluates WHERE on the new version.
   ```
2. **Pessimistic locking**: `SELECT ... FOR UPDATE` inside a transaction, then compute, then update. Other transactions block on the row lock.
3. **Optimistic concurrency** (version column). Good for low contention and for long user "think time":
   ```sql
   UPDATE documents SET body = $1, version = version + 1 WHERE id = $2 AND version = $3;
   -- 0 rows → someone else changed it → 409 Conflict / retry
   ```
   Over HTTP: `ETag` + `If-Match` → `412 Precondition Failed`.
4. **Higher isolation** (Repeatable Read/Serializable) with retries.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Guarded stock update after a successful charge](../../docs/humans/concepts/domain-payments/guarded-stock-update.md): A single guarded UPDATE on Product stock deducts quantity only if enough remains, an atomic conditional update that avoids lost updates. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [Optimistic stock deduction](../../docs/humans/concepts/domain-payments/optimistic-stock-deduction.md): Optimistic stock deduction does a cheap read before charging, then a guarded UPDATE that only succeeds if stock is still sufficient. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
<!-- theory-links:end -->

### Preventing write skew
- `SERIALIZABLE`, or
- **Materialize the conflict**: lock a shared row (`SELECT ... FOR UPDATE` on the parent/"shift" row), or
- A **constraint** that encodes the invariant (a unique constraint, or an exclusion constraint for overlapping ranges):
  ```sql
  CREATE EXTENSION btree_gist;
  ALTER TABLE bookings ADD CONSTRAINT no_overlap
    EXCLUDE USING gist (room_id WITH =, during WITH &&);   -- DB guarantees no double booking
  ```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopTransactionRunner`](../../packages/backend/libs/domains/tenancy/infra/shop-transaction.ts#L14): ShopTransactionRunner runs tenant transactions, the place where the 'shop keeps at least one owner' write-skew invariant is enforced with SERIALIZABLE and retry. _(shop-transaction.ts)_
> - [Payout row with one-per-shop-per-week rule](../../docs/humans/concepts/domain-payments/payout-model.md): A unique constraint on the payout row, one per shop per week, encodes the invariant in the schema. [`Payout`](../../packages/backend/libs/domains/payments/infra/models/payout.model.ts#L4)
<!-- theory-links:end -->

---

## 5. Row-level locks

| Lock | Taken by | Blocks |
|---|---|---|
| `FOR UPDATE` | `SELECT ... FOR UPDATE`, DELETE, UPDATE of key columns | all other row locks |
| `FOR NO KEY UPDATE` | regular UPDATE (non-key columns) | FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE; **not** FOR KEY SHARE |
| `FOR SHARE` | explicit | writers |
| `FOR KEY SHARE` | FK checks on child insert | FOR UPDATE only |

Modifiers:
- **`SKIP LOCKED`**: build a job queue on Postgres; multiple workers each grab different rows:
  ```sql
  WITH next AS (
    SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 10
  )
  UPDATE jobs SET status = 'running', locked_at = now()
  FROM next WHERE jobs.id = next.id RETURNING jobs.*;
  ```
  (This is how pg-boss and graphile-worker work. Also the outbox relay.)
- **`NOWAIT`**: fail immediately instead of waiting.

### Advisory locks
Application-defined locks keyed by a bigint:
```sql
SELECT pg_try_advisory_xact_lock(hashtext('monthly-invoice-run:2026-09'));  -- released at tx end
```
Use them for: one cron run across replicas, serializing work per entity. ⚠️ Session-level advisory locks don't work with **PgBouncer transaction pooling**. Use the `_xact_` variants.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [PostgreSQL advisory lock to serialize concurrent attempts](../../docs/humans/concepts/domain-payments/settlement-advisory-lock.md): A transaction-scoped advisory lock on a deterministic settlement identifier serializes concurrent settlement of the same order. [`SettlementListener`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L23)
> - [Exactly-once guarantee with UUIDv5, advisory lock, and existence check](../../docs/humans/concepts/domain-payments/exactly-once-settlement.md): The settlement journal gets a UUIDv5 id, an advisory lock and an existence check, so it posts exactly once despite Kafka redeliveries. [`SettlementListener`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L23)
<!-- theory-links:end -->

---

## 6. Table-level locks and DDL (where outages come from)

- Most `ALTER TABLE` forms take **ACCESS EXCLUSIVE**, which conflicts even with plain SELECT.
- The real danger is the **lock queue**: ALTER waits behind a long-running SELECT, and **every new query queues behind the ALTER**. The API freezes.
- Always: `SET lock_timeout = '3s';` before DDL, and retry. Details in the migrations doc.

---

## 7. Deadlocks

- Example: tx1 locks A then B, tx2 locks B then A. PG detects it (`deadlock_timeout`, default 1 s), aborts one with `40P01`.
- Prevention: **lock in a consistent order** (e.g. sort IDs before `SELECT ... FOR UPDATE`), keep transactions short, avoid user interaction or external calls inside transactions.
- Bulk upserts with unsorted keys arriving concurrently are a classic cause. Sort the batch by key.

---

## 8. Financial data patterns

- **Double-entry ledger**: immutable `ledger_entries` (account_id, amount, direction, tx_id). Every transaction's entries sum to zero (enforce in a constraint trigger or in code inside one DB transaction). Balances are **derived** (materialized with care), never edited in place.
- **Append-only + corrections**: a reversal entry instead of UPDATE/DELETE, which gives you an audit trail for free.
- **Idempotency keys** with a unique constraint on external operation IDs (bank transfer reference), so a retry can never double-pay.
- `numeric` columns, explicit rounding rules, currencies stored next to amounts.
- **Reconciliation jobs**: compare internal state with the external source (bank statements) and alert on any diff. This is how you *prove* the numbers are correct.

---

## 9. Transaction hygiene in Node

- Never do network I/O (HTTP to the bank, S3, email) inside a DB transaction. Do the DB work, commit, then do side effects through the **outbox**.
- Every query in a transaction must use **the same connection**. A common bug: forgetting to pass `{ transaction: t }` in Sequelize, so the query runs outside the transaction on another pooled connection. That can even **self-deadlock**: waiting on a row locked by your own open transaction.
- Set `statement_timeout`, `idle_in_transaction_session_timeout`, and `lock_timeout` per role or connection.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OutboxService`](../../packages/backend/libs/infrastructure/outbox/outbox.service.ts#L11): OutboxService records events in the database so side effects run after commit instead of inside the transaction. _(outbox.service.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: What does VACUUM do, and why does Postgres need it?**
Under MVCC, UPDATE and DELETE leave old row versions behind, and so do rolled-back inserts. VACUUM removes versions no snapshot can see anymore, along with their index entries, and makes their space reusable. It also sets visibility-map bits (needed for index-only scans), freezes old transaction IDs to prevent wraparound, and updates the free space map. Plain VACUUM doesn't block reads or writes. VACUUM FULL rewrites the table under an exclusive lock. Autovacuum runs it automatically, but its default 20% threshold needs lowering per table for big tables.

**Q: Why does the database bloat even though autovacuum is on?**
Something holds back the xmin horizon: a long-running or idle-in-transaction session, a stale replication slot, or long queries on a replica with hot_standby_feedback. VACUUM can't remove versions any snapshot might need. Or autovacuum is too throttled for the write rate. Find the oldest transaction in pg_stat_activity, set idle_in_transaction_session_timeout, and tune autovacuum per table.

**Q: What's the default isolation level in Postgres, and what can go wrong?**
Read Committed: each statement takes a fresh snapshot. Application-level read-modify-write can lose updates, and invariants spanning rows can suffer write skew. Use atomic updates, `FOR UPDATE`, optimistic versions, constraints, or Serializable with retries.

**Q: Repeatable Read vs Serializable in Postgres?**
RR is snapshot isolation: no non-repeatable reads or phantoms, and concurrent updates of the same row fail with 40001. It still allows write skew. Serializable (SSI) also detects read/write dependency cycles and aborts one transaction, so you need retry logic.

**Q: How would you implement a job queue in Postgres?**
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` inside an UPDATE ... RETURNING, plus a status column, attempt counters, `run_at` for backoff, and a reaper for stuck `running` jobs. It's simple and transactional with business data. At very high throughput, move to SQS or Kafka.

**Q: Why is a long-running transaction harmful even if it only reads?**
It holds back the xmin horizon, so vacuum can't clean dead tuples cluster-wide. Bloat and slow queries follow. On replicas with `hot_standby_feedback` it has the same effect on the primary.
