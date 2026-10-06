# PostgreSQL Indexing and Query Planning

How to find which queries need indexes, how B-tree indexes work, why Postgres sometimes ignores them, and how the planner decides.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopProductSearchService`](../../packages/backend/libs/domains/discovery/application/shop-product-search.service.ts#L19): ShopProductSearchService runs Postgres full-text search with a trigram typo-tolerance fallback, which uses GIN and pg_trgm. _(shop-product-search.service.ts)_
<!-- theory-links:end -->

---

## 1. Finding what to index

### 1.1 The method

1. **Find the expensive queries** with `pg_stat_statements` (§1.2).
2. **Find tables that are scanned in full too often** with `pg_stat_user_tables` (§1.3).
3. **Capture real plans of slow queries** in production with `auto_explain` (logs the `EXPLAIN` plan of every query slower than `auto_explain.log_min_duration`).
4. **Connect queries to code** with APM/traces: which endpoint issues the query, and how often per request (N+1?).
5. **Reproduce** with `EXPLAIN (ANALYZE, BUFFERS)` on production-like data volumes (§5).
6. **Add the index** with `CREATE INDEX CONCURRENTLY`, then verify: the plan changes, the query's mean time in `pg_stat_statements` drops, and the index's `idx_scan` counter in `pg_stat_user_indexes` grows.
7. **Periodically remove indexes nobody uses** (§1.4).

### 1.2 `pg_stat_statements`

An extension shipped with Postgres that records **statistics for every distinct query shape**. Queries are *normalized*: constants are replaced by placeholders, so `WHERE id = 5` and `WHERE id = 7` are counted as one entry, `WHERE id = $1`. Entries are identified by `queryid` (a hash of the parsed query) per database and user.

Setup:

```sql
-- postgresql.conf (requires a restart):
--   shared_preload_libraries = 'pg_stat_statements'
--   track_io_timing = on              -- optional: adds I/O time columns
CREATE EXTENSION pg_stat_statements;  -- once per database
```

On RDS/Aurora and most managed services, the library is preloaded already; you only run `CREATE EXTENSION`.

Behavior worth knowing:
- Counters are **cumulative since the last reset** (`SELECT pg_stat_statements_reset();`) or server restart. To measure a period ("what changed after the deploy?"), take two snapshots and diff them, or reset and wait.
- It keeps at most `pg_stat_statements.max` entries (default 5,000). The least-used entries are evicted when it's full.
- `pg_stat_statements.track = top` (default) counts statements sent by clients; `all` also counts statements run inside functions.

**Does it slow the database down?** Only slightly, and it affects both latency and load in the same small way. For every statement, Postgres also updates that query's counters in shared memory (under a short per-entry lock). That adds microseconds of CPU per query: invisible in the latency of millisecond-level queries, and typically well under a few percent of total CPU. It's standard to leave it on in production. The cases where the overhead becomes noticeable:
- very high rates (tens of thousands per second) of the **same** tiny query, which contend on that entry's lock;
- `pg_stat_statements.track_planning = on` (off by default), which adds planning statistics and more contention;
- a workload with far more distinct query shapes than `max`, so entries keep being evicted and query texts rewritten to disk;
- `track_io_timing = on` on systems with a slow clock source (check with the `pg_test_timing` tool first).

Query for the top load contributors:

```sql
SELECT
  queryid,
  calls,
  round(total_exec_time)                                           AS total_ms,
  round(mean_exec_time::numeric, 2)                                AS mean_ms,
  round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 1) AS pct_of_total,
  rows,
  rows / nullif(calls, 0)                                          AS rows_per_call,
  shared_blks_hit,
  shared_blks_read,
  round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct,
  temp_blks_written,
  left(query, 120)                                                 AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

(`mean_exec_time` is a `double precision`, and Postgres has no two-argument `round` for that type, hence the `::numeric` casts.)

| Column | Meaning | How to use it |
|---|---|---|
| `queryid` | hash identifying the normalized query | stable ID to track a query across snapshots and in logs |
| `calls` | how many times it ran | high calls with tiny time each can still be top load (N+1 patterns) |
| `total_exec_time` | total execution time in ms, all calls | **sort by this to find what loads the database**: frequency × cost |
| `mean_exec_time` | average ms per call (also `min_`, `max_`, `stddev_exec_time`) | **sort by this to find individually slow queries** (slow endpoints); large `stddev` = sometimes slow (parameter-dependent plans, lock waits) |
| `pct_of_total` (computed) | this query's share of all execution time | focus on the few queries with the biggest share |
| `rows` | total rows returned or affected | `rows_per_call` far above what the UI shows = missing `LIMIT` or over-fetching |
| `shared_blks_hit` | 8 KB pages found in Postgres's shared buffer cache | memory reads, cheap |
| `shared_blks_read` | pages not in shared buffers, read from the OS (page cache or disk) | high values = the query touches a lot of data that isn't hot; often a sign of seq scans or a missing index |
| `cache_hit_pct` (computed) | hit / (hit + read) | low for a frequent query = it reads more data than fits in memory |
| `temp_blks_written` | pages spilled to temp files | sorts or hashes exceeding `work_mem`: add an index matching `ORDER BY`, reduce rows, or raise `work_mem` for that query |
| `query` | normalized query text | identify the code that issues it |

Other useful columns: `plans` / `total_plan_time` (with `track_planning`), `shared_blks_dirtied` / `shared_blks_written` (write load), `shared_blk_read_time` (I/O wait, needs `track_io_timing`; named `blk_read_time` before PG 17), `wal_bytes` (write-ahead log generated, which drives replication lag).

### 1.3 `pg_stat_user_tables`: tables read in full too often

One row per table with **cumulative counters** since the last stats reset:

```sql
SELECT
  relname                              AS table_name,
  seq_scan,
  seq_tup_read,
  seq_tup_read / nullif(seq_scan, 0)   AS avg_rows_per_seq_scan,
  idx_scan,
  n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC
LIMIT 20;
```

| Column | Meaning |
|---|---|
| `seq_scan` | number of sequential scans (full reads of the table) started |
| `seq_tup_read` | total rows read by all those sequential scans |
| `avg_rows_per_seq_scan` (computed) | how big each full scan is |
| `idx_scan` | number of index scans on this table (all its indexes combined) |
| `n_live_tup` | estimated current row count |

How to read it:
- A **big table** (`n_live_tup` in the millions) with a **high `seq_scan` count** and `avg_rows_per_seq_scan` close to `n_live_tup` is being read in full repeatedly: a strong sign of a missing index (or a query that can't use one, §4). Find the query in `pg_stat_statements` and check its plan.
- Seq scans on **small tables** are normal and fine; the planner prefers them (§4.5).
- An occasional seq scan on a big table can be legitimate (nightly report, backup, `VACUUM` doesn't count). Look at the rate, not one value.
- Other columns in the same view are useful too: `n_dead_tup` and `last_autovacuum` (vacuum health, §3.2), `last_analyze`/`last_autoanalyze` (statistics freshness, §4.6), `n_tup_hot_upd` (HOT updates, §6). PG 16+ adds `last_seq_scan` and `last_idx_scan` timestamps.

### 1.4 Finding unused and redundant indexes

Every index slows down writes (each INSERT, and each UPDATE that touches indexed columns, must update it), produces more WAL (replication lag), uses disk, and competes for memory. Indexes that are never read are pure cost.

**Unused indexes** (never scanned since the last stats reset):

```sql
SELECT
  s.relname                                       AS table_name,
  s.indexrelname                                  AS index_name,
  s.idx_scan,
  pg_size_pretty(pg_relation_size(s.indexrelid))  AS index_size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique          -- unique indexes enforce constraints even if never scanned
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

**Exact duplicates** (same columns, same expressions, same `WHERE`):

```sql
SELECT
  indrelid::regclass                AS table_name,
  array_agg(indexrelid::regclass)   AS duplicate_indexes
FROM pg_index
GROUP BY indrelid, indkey::text, indclass::text,
         coalesce(indexprs::text, ''), coalesce(indpred::text, '')
HAVING count(*) > 1;
```

**Redundant by prefix**: an index on `(a)` is usually covered by an index on `(a, b)` (leftmost prefix, §3.1), so the single-column one can often go. Exceptions: the smaller index may be noticeably faster for very hot queries, or it may be unique.

Before dropping anything:
- **Check every replica.** Statistics are per server. An index unused on the primary may serve all the read traffic on a replica.
- **Check how long the stats cover.** If they were reset yesterday, a monthly report's index looks unused. Look at `stats_reset` in `pg_stat_database`, and wait out at least one full business cycle (month-end jobs!).
- Drop with `DROP INDEX CONCURRENTLY` (no blocking of writes), and keep the `CREATE INDEX` statement ready to restore it.
- Also look for **invalid indexes** left by a failed `CREATE INDEX CONCURRENTLY` (`pg_index.indisvalid = false`). They cost writes and are never used.

---

## 2. Index types

| Type | Good for | Notes |
|---|---|---|
| **B-tree** (default) | `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, `LIKE 'prefix%'` (with `text_pattern_ops` or C collation) | 95% of indexes |
| **Hash** | equality only | WAL-logged since PG10; rarely better than B-tree |
| **GIN** | "contains" queries: `jsonb @>`, arrays `&&`/`@>`, full-text `tsvector`, `pg_trgm` for `ILIKE '%foo%'` | slower writes (fastupdate pending list), large |
| **GiST** | ranges, geometry, nearest-neighbor, **exclusion constraints** (no overlapping ranges) | lossy, flexible |
| **SP-GiST** | partitioned spaces (quadtrees, IP ranges) | niche |
| **BRIN** | huge append-only tables where values correlate with physical order (`created_at` in event/log tables) | tiny (KBs for TBs), coarse |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopProductSearchService`](../../packages/backend/libs/domains/discovery/application/shop-product-search.service.ts#L19): ShopProductSearchService uses full-text (GIN tsvector) and pg_trgm trigram indexes for product search. _(shop-product-search.service.ts)_
<!-- theory-links:end -->

---

## 3. B-tree design rules

> All `EXPLAIN` outputs in §3–§5 come from a real **PostgreSQL 17** run on a 100k-row test table, not from memory.

### 3.0 What a B-tree actually is (and why it isn't a red-black tree)

A B-tree is a **self-balancing tree**, but it's a **different family** from red-black trees:

| | Red-black tree | B-tree (Postgres: B+tree variant) |
|---|---|---|
| Fan-out | **binary**: each node has ≤ 2 children | **wide**: one node = one **8 KB disk page** holding **hundreds** of keys → hundreds of children |
| Height for 10M keys | ~2·log₂(10M) ≈ **up to ~46** levels | **3–4** levels |
| Designed for | **in-memory** structures (Java `TreeMap`, C++ `std::map`, Linux scheduler) where following a pointer is cheap | **disk/page storage**, where every level = potentially one I/O, so you want as few levels as possible |
| How it stays balanced | recoloring + rotations after insert/delete | when a page is full, it **splits** into two and pushes a separator key up to the parent; if the root splits, the tree grows **one level taller at the top**. All leaves therefore stay at the **same depth**, so every lookup costs the same number of page reads |

Postgres's B-tree (the Lehman & Yao "B-link" tree, a **B+tree** variant) has this layout:
```
                  [ root page:  ... 300 | 600 ... ]                 ← internal pages: only separator keys + child pointers
                 /               |               \
   [internal: 100|200]   [internal: 400|500]   [internal: 700|800]
      /    |    \             ...                    ...
[leaf] ⇄ [leaf] ⇄ [leaf] ⇄ [leaf] ⇄ ... ⇄ [leaf]                    ← leaf pages: (key, TID) entries, SORTED,
                                                                       linked left↔right to each other
```
- **Leaf entries** = the indexed key value(s) + a **TID** (tuple ID: `(page number, slot)` pointing to the row in the table's heap). Plus any `INCLUDE` columns.
- **Leaves are linked**, so a range scan (`BETWEEN`, `>`, `ORDER BY ... LIMIT`) descends **once** to the first matching key and then walks **sideways** through the leaves. That's why B-trees are good at ranges and sorting, which hash indexes can't do.
- A lookup costs `height` page reads (3–4) plus reading the heap row.

### 3.1 Composite index column order: why only the "leftmost prefix" works

An index on `(a, b, c)` serves queries on `a`, on `a, b`, and on `a, b, c`. This is the **leftmost prefix** rule. It doesn't efficiently serve `b` alone. PG 18 added *skip scan*, which helps when `a` has few distinct values, but don't count on it.

Design rules:

- Put **equality columns first, then the range or sort column**. A range column in the middle stops the index from narrowing on the columns after it.
- Query shape matters more than selectivity. Columns that are always filtered with equality go first.

Example query and matching index:

```sql
-- WHERE tenant_id = 42 AND status = 'open'
--   AND created_at > now() - interval '7 days'
-- ORDER BY created_at DESC
CREATE INDEX CONCURRENTLY idx_tickets_tenant_status_created
  ON tickets (tenant_id, status, created_at DESC);
```

**Why the rule exists.** A composite B-tree stores entries sorted lexicographically: by the first column, then by the second column only within equal values of the first. It works like a phone book sorted by (last name, first name).

Example: a table of likes, where each row says "user X liked post Y", with the primary key (and therefore a B-tree index) on `(user_id, post_id)`:

```sql
CREATE TABLE post_likes (
  user_id  bigint NOT NULL,
  post_id  bigint NOT NULL,
  liked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
```

The index entries are stored in this order:

```
(user_id, post_id) entries in leaf order:

(1, 7) (1, 9) (1, 42) | (2, 3) (2, 7) (2, 8) | (3, 1) (3, 7) ... (999, 7) (999, 12)
 <-- user 1 likes -->    <-- user 2 likes -->
```

What each query can do with that order:

| Query | Meaning | What the tree can do | Result |
|---|---|---|---|
| `user_id = 2` | all posts user 2 liked | jump to the first `(2, ...)` entry and read the contiguous run | efficient |
| `user_id = 2 AND post_id = 7` | did user 2 like post 7? | jump straight to `(2, 7)` | most efficient |
| `post_id = 7` | who liked post 7? | nothing to jump to: post 7's likes are scattered, one inside every user's group, so every leaf page must be read | full index scan |
| `user_id > 900 AND post_id = 7` | which users above 900 liked post 7? | jump to `user_id = 901`, then read every entry after it and filter on `post_id` | only `user_id` narrows the search |

Finding "who liked post 7" with this index is like finding everyone named "John" in a phone book sorted by last name: you have to read the whole book. Columns after a range condition can only filter, never narrow.

The fix for "who liked post 7" is a second index that starts with `post_id`: `CREATE INDEX ON post_likes (post_id, user_id);`. Real apps with both access patterns ("my likes" and "likes of this post") have both indexes.

**Measured on PostgreSQL 17** (same shape of table and index, 100k rows): for the query on the second column alone, Postgres still used the index, but it had to read the **entire index (~100% of its pages)**, compared with **under 1%** for the full-key lookup and **~10%** for the range-plus-equality query. Postgres used the index only because the whole index was smaller to read than the table. The index gave no narrowing at all, so on a big table that query stays slow. "Not efficiently served" doesn't mean "not used".

**PG 18 skip scan.** If the first column has few distinct values (for example a `status` column with 5 values), PG 18 can do 5 small lookups (`status = v1 AND post_id = 7`, `status = v2 AND post_id = 7`, and so on) instead of scanning everything. With a high-cardinality first column like `user_id`, there are too many values to skip through, so it's no better than a full scan.

### 3.2 Covering indexes, index-only scans, the visibility map, VACUUM, heap fetches

**Normal index scan vs index-only scan.** In a normal **Index Scan**, Postgres walks the index to find matching entries, follows each entry's TID (tuple ID: page + slot) to the row in the table (the **heap**), and reads the columns there. That heap visit also checks whether the row version is visible to the current transaction, at no extra cost, because the row is being read anyway.

An **Index Only Scan** skips the heap: it's possible when **every column the query needs** (in `SELECT`, `WHERE`, `ORDER BY`) is stored in the index. Nothing special is needed in the SQL. Postgres decides everything automatically, at two levels:

- **at planning time**, the planner picks an Index Only Scan when the index covers the query (and the visibility map says enough pages are all-visible to make it worthwhile);
- **at execution time**, for **each index entry**, it checks the visibility map and reads the table page only when needed (a heap fetch, explained below).

To make a query eligible, index the columns it needs, or add them as non-key payload with `INCLUDE`:

```sql
CREATE INDEX idx_orders_user ON orders (user_id) INCLUDE (status, total_cents);
-- SELECT status, total_cents FROM orders WHERE user_id = 42   → Index Only Scan

-- post_likes from §3.1, primary key (user_id, post_id):
-- SELECT post_id FROM post_likes WHERE user_id = 42           → Index Only Scan (both columns are in the key)
-- SELECT post_id, liked_at FROM post_likes WHERE user_id = 42 → Index Scan (liked_at is only in the heap)
```

(`INCLUDE` columns are stored only in the leaves and aren't part of the sort order, so they can't be searched on. They just ride along so the heap doesn't have to be visited.)

**Indexes and row visibility, step by step.**

Background: row versions, `xmin`/`xmax`, snapshots, and what VACUUM does are explained in `02-transactions-isolation-locking.md` §1.

Two facts make this work:

1. **Indexes know which row versions exist, but not who may see them.** Every INSERT and every UPDATE adds index entries for the new row version. But an index entry is only "value → location of a row in the table". Who created or deleted that row version (`xmin`/`xmax`), and therefore which transactions may see it, is stored **only in the table row**.
2. **The table is stored in 8 KB pages**, each holding many rows. The **visibility map** keeps **one bit per page** meaning "every row on this page is visible to everyone". **VACUUM** turns the bit on after cleaning the page. **Any INSERT, UPDATE, or DELETE touching the page turns it off.**

Example: `post_likes` with primary key `(user_id, post_id)`, and the query `SELECT post_id FROM post_likes WHERE user_id = 2`. Both columns are in the index, so the planner uses an Index Only Scan.

**Step 1: A transaction inserts a row, then VACUUM marks its page.** Transaction 100 inserts "user 2 liked post 7" as row A on table page 5, and the index gets the entry `(2, 7) → page 5`. Later, VACUUM checks page 5, sees that row A is visible to every transaction, and turns page 5's bit ON.

```
table page 5:   row A {user 2, post 7, xmin=100}
index:          (2, 7) → page 5
visibility map: page 5 = ON
```

**Step 2: A query reads from the index only.** The index finds `(2, 7) → page 5`. Page 5's bit is ON, so Postgres returns post 7 without reading the table.

**Step 3: Another transaction deletes the row.** Transaction 200 deletes the like. Row A is only marked as deleted (`xmax=200`) and stays on page 5. The index entry doesn't change. Because the page was written to, its bit turns OFF.

```
table page 5:   row A {user 2, post 7, xmin=100, xmax=200}
index:          (2, 7) → page 5        (unchanged)
visibility map: page 5 = OFF
```

**Step 4: The same query now has to check the table.** The index still finds `(2, 7) → page 5`, but the bit is OFF, so Postgres reads page 5 (a **heap fetch**) and checks row A's `xmin`/`xmax` against the reader's snapshot:
- a reader whose snapshot started **before** transaction 200 committed doesn't see the delete, so it still gets post 7;
- a reader whose snapshot started **after** sees the row as deleted and skips it.

**Step 5: VACUUM cleans up.** Once no running transaction can still see row A, VACUUM removes row A from page 5 and the `(2, 7)` entry from the index, then turns page 5's bit back ON. The query is index-only again.

**Why VACUUM is needed after an INSERT too.** Right after transaction 100 commits, row A is *not yet* visible to everyone: transactions whose snapshots started before 100 committed must not see it. So "every row on this page is visible to everyone" isn't true yet. VACUUM's jobs are:
- remove dead row versions (left by DELETE, UPDATE, and rolled-back INSERTs) and their index entries;
- **mark pages all-visible** once every row on them is visible to all transactions, including freshly inserted ones (and later mark them all-frozen);
- record free space so new rows can reuse it.

That's why, since PG 13, autovacuum also runs on tables that only receive INSERTs (`autovacuum_vacuum_insert_threshold` / `_scale_factor`): mainly to set visibility bits and freeze rows on append-only tables.

**Does the map work under heavy load?** Yes, because a bit is cleared only when a **write touches that page**. Running transactions and reads don't clear anything. On busy databases, writes usually concentrate on a small part of the table:
- INSERTs go to the newest pages at the end of the table;
- UPDATEs hit "hot" rows (recent orders, active sessions);
- the bulk of a large table (last year's orders) isn't written to and stays all-visible.

A 100M-row orders table where only recent orders change can have 99% of its pages all-visible, so index-only scans over old data stay cheap. It breaks down when:
- updates are **spread randomly across the whole table** (e.g. updating `last_seen_at` on every user on each login). Then most pages are cleared, and index-only scans turn into heap fetches. In the PG 17 test below, updating just 10% of the rows touched every page;
- **long-running transactions** keep old snapshots alive, so VACUUM can't declare rows "visible to everyone" and can't set bits;
- autovacuum runs too rarely for that table (tune it per table).

UPDATE works the same way: it writes a **new** row version and adds index entries for it, and the old version and its old entries stay until VACUUM. (Exception, a **HOT update**: if no indexed column changed and the new version fits on the same page, no index entry is added.)

Summary:

| Page's visibility-map bit | Index Only Scan does | Why |
|---|---|---|
| ON (set by VACUUM, nothing written since) | answers from the index only | every row on that page is visible to every transaction |
| OFF (something wrote to the page since the last VACUUM) | reads the table page to check `xmin`/`xmax` (a **heap fetch**) | the index can't tell which row versions this transaction may see |

A normal **Index Scan** reads the table row anyway (it needs columns that aren't in the index), so it always checks visibility there and the visibility map doesn't matter to it.

Why Postgres doesn't store `xmin`/`xmax` in index entries too: every DELETE and UPDATE would then also have to update every index entry of that row, which would make writes and indexes much more expensive. (The visibility map also has a second bit per page, *all-frozen*, used by anti-wraparound vacuum.)

Measured on PG 17 (200k-row `orders`, `WHERE user_id = 42` → 200 rows, autovacuum disabled for the demo):

| State | VM all-visible pages | Plan | Heap Fetches | Pages read |
|---|---|---|---|---|
| right after bulk INSERT (never vacuumed) | 0 / 3847 | **Bitmap Heap Scan** (planner knows the VM is empty, so an index-only scan has no benefit) | — | 203 |
| after `VACUUM` | 3847 / 3847 | **Index Only Scan** | **0** | **4** |
| after `UPDATE` of 10% of rows | **0** / 4231 (every page had at least one updated row) | Index Only Scan | **200** | 204 |
| after `VACUUM` again | all | Index Only Scan | **0** | **4** |

```
Index Only Scan using orders_user_cov on orders (actual rows=200 loops=1)
  Index Cond: (user_id = 42)
  Heap Fetches: 200          ← each of these = a trip to the table; the "index-only" benefit is gone
  Buffers: shared hit=204
```

Practical consequences:
- On **write-heavy tables**, index-only scans degrade into "index scan + heap lookups" until vacuum catches up. Insert-mostly / append-only tables (events, logs, ledger entries) benefit the most.
- If you rely on index-only scans, make autovacuum **more aggressive** for that table: `ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01)`. Insert-only tables also get vacuumed for this since PG 13 (`autovacuum_vacuum_insert_scale_factor`).
- **Watch `Heap Fetches`** in `EXPLAIN (ANALYZE)`: if it's close to `rows`, the covering index isn't paying for itself.
- `CREATE EXTENSION pg_visibility; SELECT sum(all_visible::int), count(*) FROM pg_visibility_map('orders');` shows the VM state.

### 3.3 Partial indexes: an index with a `WHERE` condition
An index with a `WHERE` clause is a **partial index**. It only contains entries for rows that match the predicate:
```sql
CREATE INDEX idx_jobs_pending ON jobs (run_at) WHERE status = 'pending';   -- tiny, hot
CREATE UNIQUE INDEX uq_active_email ON users (lower(email)) WHERE deleted_at IS NULL; -- soft-delete-aware uniqueness
```
- **Smaller and faster**: if 1% of jobs are pending, the index is ~100× smaller, stays in memory, and costs nothing on writes to rows outside the predicate (as long as they don't move in or out of it).
- **Usable only when the planner can prove** that the query's `WHERE` implies the index predicate. `WHERE status = 'pending' AND run_at < now()` matches; `WHERE status = $1` with a parameter generally doesn't when a generic plan is used, because the planner can't prove `$1 = 'pending'`.
- **Partial unique index** = "unique among the rows matching the condition": only one *active* user per email, while soft-deleted duplicates are allowed. That's impossible with a plain `UNIQUE` constraint.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Payout row with one-per-shop-per-week rule](../../docs/humans/concepts/domain-payments/payout-model.md): The Payout row uses a unique constraint, one payout per shop per week, which keeps the weekly job idempotent. It is a unique-constraint design, not a partial index. [`Payout`](../../packages/backend/libs/domains/payments/infra/models/payout.model.ts#L4)
<!-- theory-links:end -->

### 3.4 Expression indexes
`uq_active_email` above is **both** partial (`WHERE deleted_at IS NULL`) **and** an expression index (`lower(email)`). An expression index stores the **computed value** instead of the raw column:
```sql
CREATE INDEX idx_users_lower_email ON users (lower(email));
-- query MUST use the same expression: WHERE lower(email) = lower($1)
```
Rules:
- The query must contain **the exact same expression**. `WHERE email ILIKE $1` or `WHERE lower(trim(email)) = …` won't use it.
- The expression must be **IMMUTABLE** (same input → same output forever). Verified on PG 17: `CREATE INDEX ON t (date(created_at))` on a `timestamptz` column **fails** with `functions in index expression must be marked IMMUTABLE`, because the date of a timestamptz depends on the session's `TimeZone` setting. Pin the zone explicitly: `CREATE INDEX ON t (((created_at AT TIME ZONE 'UTC')::date))`. That works, and is used by `WHERE (created_at AT TIME ZONE 'UTC')::date = '2026-09-01'`.
- Postgres keeps separate statistics for indexed expressions (gathered by `ANALYZE`), so estimates on `lower(email) = …` are accurate too.

---

## 4. Why an index isn't used (checklist)

Quick list:
1. A function or cast on the column: `WHERE date(created_at) = ...`, `WHERE id::text = ...`. Rewrite as a range: `created_at >= $d AND created_at < $d + 1`.
2. A type mismatch that forces a cast on the column (e.g. an `integer` column compared with a `numeric` value).
3. A leading wildcard: `LIKE '%foo'` (and even `LIKE 'foo%'` under a non-C collation without `text_pattern_ops`). Use `pg_trgm` GIN.
4. `OR` across columns where one side has no usable index. Use a `UNION` or index both sides so a BitmapOr works.
5. **Low selectivity**: when the query returns a large share of the table, a seq scan really is cheaper.
6. **Stale or insufficient statistics**: the planner estimates wrong row counts and picks a bad plan.
7. A generic plan for prepared statements (`plan_cache_mode`) chosen for skewed parameters.
8. The table is small. A seq scan of 10 pages beats any index.

The root cause behind 1–3 is one rule: **a B-tree can only be searched by the exact values (and the exact sort order) it stores.** If the query asks about something the index doesn't contain, the tree's ordering can't be used.

### 4.1 A function or cast on the column

The index on `created_at` stores **timestamps**, sorted. `WHERE date(created_at) = '2026-09-21'` asks about the **result of a function**. To use the index, Postgres would have to know which timestamps produce that date. Postgres doesn't reason about arbitrary functions' outputs, so it computes `date(created_at)` for **every row** (Seq Scan + Filter).

Verified on PG 17:
```
WHERE date(created_at) = current_date - 10
→ Seq Scan on t   Filter: (date(created_at) = (CURRENT_DATE - 10))

WHERE created_at >= current_date - 10 AND created_at < current_date - 9      -- same meaning, rewritten as a range
→ Index Scan using t_created on t
     Index Cond: ((created_at >= (CURRENT_DATE - 10)) AND (created_at < (CURRENT_DATE - 9)))
```
The rewrite moves all computation to the **constant side**. Postgres evaluates `current_date - 10` once, then does a normal range search in the tree. Use a half-open range (`>= start AND < next`), not `BETWEEN`, which includes the end and would double count midnight.

Same with casts. `WHERE id::text = '500'` casts the **column** for every row (`Seq Scan, Filter: ((id)::text = '500'::text)`), while `WHERE id = 500` uses the primary key index. Rule of thumb: **leave the indexed column "naked"** and transform the *other* side. If you really can't, create an **expression index** on exactly that expression (§3.4).

Common real-world forms: `WHERE lower(email) = …` (needs an expression index), `WHERE EXTRACT(YEAR FROM created_at) = 2026` (rewrite as a range), `WHERE created_at + interval '1 day' > now()` (rewrite as `created_at > now() - interval '1 day'`), `WHERE COALESCE(deleted, false) = false`.

### 4.2 Type mismatch → hidden cast on the column

When the two sides of `=` have different types, Postgres has to convert one of them. If it converts the **column**, you're back in 4.1: an invisible function on the column.

Verified on PG 17:
```
integer column c, numeric value:
WHERE c = 5.0           → Seq Scan   Filter: ((c)::numeric = 5.0)          ← column cast to numeric, index unusable
WHERE c = 5             → Bitmap Index Scan on t_c                         ← same type, index used
WHERE c = 5::bigint     → Bitmap Index Scan on t_c   Index Cond: (c = '5'::bigint)  ← int4 vs int8 is FINE
```
Why `int4 = int8` is fine but `int4 = numeric` isn't: B-tree **operator families** group types that can be compared without conversion. `int2`, `int4`, and `int8` are in one family (`integer_ops`), and so are `text`/`varchar`, or `date`/`timestamp`/`timestamptz`. Comparisons **within** a family can use the index directly. `numeric` is a different family, so Postgres casts the integer column up to numeric.

Notes:
- Postgres is strict: `varchar_column = 123::numeric` is simply an **error** ("operator does not exist: character varying = numeric", verified), unlike **MySQL**, which silently converts the string column to a number for every row and skips the index. That MySQL behavior is the classic version of this bug.
- Where it bites in Node: a driver or ORM binding a JS number as `numeric`/`float8` (e.g., `1.0`-style values, decimal libraries), a parameter typed from a different column (`WHERE user_id = $1` where `$1` comes from a `numeric` or `text` field), comparing `jsonb ->> 'id'` (text) to an integer column, or `uuid` columns compared with `text` parameters (`WHERE uuid_col::text = $1`).
- How to spot it: in `EXPLAIN`, look for `::` casts applied **to the column name** in `Filter:` lines.

### 4.3 Leading wildcard `LIKE '%foo'` (and the collation gotcha for `LIKE 'foo%'`)

A B-tree on `note` is sorted **from the first character**, like a dictionary. `LIKE '1234%'` means "starts with 1234". In sorted order, those values are one contiguous block between `'1234'` and `'1235'`, so the tree can jump there:
```
WHERE note LIKE '1234%'  (index with varchar_pattern_ops)
→ Index Scan using t_note_pattern
     Index Cond: ((note ~>=~ '1234') AND (note ~<~ '1235'))      ← Postgres rewrote LIKE into a range!
     Filter: (note ~~ '1234%')
```
`LIKE '%234'` means "**ends** with 234". Those values are scattered all over the dictionary (`'0234'`, `'1234'`, `'9234'` …), so there's nothing to jump to. Result: Seq Scan. (Finding words that *end* in "-tion" in a paper dictionary is the same problem.)

**Collation gotcha (verified):** with the default Docker/Linux collation `en_US.utf8`, even `LIKE '12%'` did **not** use a plain B-tree index. Linguistic collations sort with complex rules (ignoring punctuation at first, case handling, etc.), so "starts with" isn't guaranteed to be a contiguous range in that order. Fixes: create the index with `text_pattern_ops` / `varchar_pattern_ops` (byte-wise ordering, as above), or use the `C` collation for that column or index.

**Fix for contains / ends-with search: trigram GIN index** (`pg_trgm`). It splits every value into 3-character chunks (`'1234'` → `"  1"`, `" 12"`, `"123"`, `"234"`, `"34 "`) and indexes which rows contain each trigram. `LIKE '%234'` becomes "rows whose trigram set contains the trigrams of `234`" (a fast index lookup), then each candidate row is rechecked against the real pattern:
```sql
CREATE EXTENSION pg_trgm;
CREATE INDEX t_note_trgm ON t USING gin (note gin_trgm_ops);
-- WHERE note LIKE '%234'  → Bitmap Index Scan on t_note_trgm   (verified)
-- also serves ILIKE '%foo%' and similarity searches (fuzzy matching)
```
Trigram indexes need at least ~3 characters in the pattern to be selective, and they're larger and slower to update than B-trees. For real full-text search (words, stemming, ranking) use `tsvector` + GIN instead.

### 4.4 `OR` across different columns

A single B-tree on `a` can find `a = 5` rows. It knows nothing about `c`. `WHERE a = 5 OR c = 7` needs rows from **two unrelated places**.
- **If both columns have indexes**, Postgres combines them with a **BitmapOr**: it scans index 1 and builds a bitmap of matching heap pages, scans index 2 for another bitmap, ORs the bitmaps, then reads each needed heap page once. Verified:
  ```
  Bitmap Heap Scan on t   Recheck Cond: ((a = 5) OR (c = 7))
    ->  BitmapOr
          ->  Bitmap Index Scan on t_a   Index Cond: (a = 5)
          ->  Bitmap Index Scan on t_c   Index Cond: (c = 7)
  ```
- **If even one side has no usable index**, the whole OR has to scan the table, because rows matching the unindexed side could be anywhere. Verified: `WHERE a = 5 OR status = 'x'` (no index on status) → `Seq Scan, Filter: ((a = 5) OR (status = 'x'))`.
- The same applies to a composite index `(a, b)` with `WHERE a = 5 OR b = 7`: the `b` side can't seek (leftmost prefix rule).
- Fixes: index the missing side; or rewrite as a **`UNION`** (each branch uses its own best index; `UNION` dedupes, `UNION ALL` + `AND NOT (...)` avoids the dedupe cost):
  ```sql
  SELECT * FROM t WHERE a = 5
  UNION
  SELECT * FROM t WHERE c = 7;
  ```
- `OR` on the **same** column (`status = 'a' OR status = 'b'`) is fine. Postgres turns it into `status = ANY('{a,b}')`, a single index condition.

### 4.5 Low selectivity: why a seq scan can be cheaper (and what happens at 100k rows)

**Selectivity** = the fraction of rows a condition returns. "Low selectivity" = the condition matches **a lot** of rows.

The key fact: **Postgres reads whole 8 KB pages, not rows.** A page holds dozens to hundreds of rows. Rows matching an indexed value are usually **scattered randomly** across pages (they were inserted at different times).

The costs being compared:
- **Seq Scan**: read **every page once, in order**. Sequential I/O is the cheapest kind: the OS reads ahead, and on spinning disks there's no seeking. Cost ∝ number of pages. The planner's default `seq_page_cost = 1`.
- **Index Scan**: walk the index, and for **each matching entry** jump to its heap page: **random** I/O, default `random_page_cost = 4`. If the rows are scattered, the *same* page may be visited many times, plus you also read the index pages.
- **Bitmap Index + Heap Scan** (the middle ground): collect all matching TIDs from the index into a bitmap, **sort them by page**, then read each needed page **once, in physical order**. That's why it showed up so often in the tests below.

**What happens at 100k rows (measured on PG 17)**: table `t` = 100k rows, **935 pages** (~107 rows per page), random values in `c`, index on `c`:

| Condition | % of rows | Planner's choice | Heap pages touched |
|---|---|---|---|
| `c < 1` | 0.06% | Bitmap scan | 57 |
| `c < 10` | 1% | Bitmap scan | **598 (64% of the table!)** |
| `c < 30` | 3% | Bitmap scan | **907 (97%)** |
| `c < 100` | 10% | Bitmap scan | 945 (all) |
| `c < 400` | 40% | Bitmap scan | 971 (all) |
| `c < 700` | 70% | **Seq Scan** | 935 (all) |

The big lesson: **at just 1% of rows, the query already touches 64% of the pages, and at 3% it touches almost all of them.** With ~107 rows per page and matches spread randomly, nearly every page contains at least one match. From that point on, an index can't save any page reads. It only *adds* work (reading the index, building the bitmap, jumping around), so the planner moves to a Seq Scan. The 5–10% figure is a rough rule; the real threshold depends on rows per page, physical order, and cost settings.

For the 30% case, the planner's cost estimates were: Bitmap scan **1649**, Seq Scan **2185**, plain Index Scan **4372** (that's the random-I/O penalty: revisiting pages in index order). Actual times were all ~3–4 ms, because **100k rows is tiny**: the 7.5 MB table sits entirely in RAM (`shared hit`, no disk reads), so every plan is fast. At this size, the choice of plan barely matters. On a **100M-row, 75 GB table** that isn't cached, the same ratios become seconds vs minutes, and that's when getting the plan right matters.

**Physical order changes everything (correlation)**: after `CLUSTER t USING t_c` (rewrite the table sorted by `c`), `pg_stats.correlation` for `c` became **1.0**. Now matching rows sit in **adjacent pages**, and a plain Index Scan for 30% of rows cost only **912** (vs 4372 before) and was the fastest plan. Naturally correlated columns, like `created_at` or `id` in an append-only table, get this effect for free. That's why time-range queries on event tables use indexes efficiently even for large ranges, and why **BRIN** indexes work on them.

Tuning note: on SSD/NVMe or fully cached databases, random reads are nearly as cheap as sequential ones. Many teams lower `random_page_cost` to **1.1–1.5**, which makes the planner more willing to use indexes. The default of 4 assumes spinning disks.

### 4.6 Planner statistics: what they are, and how stale or insufficient stats break plans

The planner chooses plans based on **estimated row counts** ("how many rows will this condition return?"), because every cost depends on that number. It doesn't count rows at planning time (that would take as long as running the query). It looks up **statistics** collected earlier by **`ANALYZE`**.

**What ANALYZE collects**: it reads a **random sample** of the table (`300 × default_statistics_target` rows = 30,000 rows by default) and stores, per column, in `pg_statistic` (readable through the `pg_stats` view):

| Statistic | Meaning | Used for |
|---|---|---|
| `null_frac` | fraction of NULLs | `IS NULL` estimates |
| `n_distinct` | number of distinct values (or negative = fraction of rows) | equality on non-common values, GROUP BY sizes |
| `most_common_vals` + `most_common_freqs` (MCV list) | the most frequent values and their frequencies | `= value` for common/skewed values |
| `histogram_bounds` | values splitting the *rest* of the data into equal-population buckets | range conditions (`<`, `BETWEEN`) |
| `correlation` | how well the physical row order matches the column's sort order (−1…1) | cost of index scans (random vs sequential, §4.5) |

Plus table-level `reltuples`/`relpages` in `pg_class` (estimated row and page counts).

Real `pg_stats` row from the test (100k rows, `plan` column with skewed values):
```
attname | n_distinct | most_common_vals          | most_common_freqs
plan    |          3 | {free,pro,enterprise}     | {0.8999, 0.0993, 0.00083}
```
So for `WHERE plan = 'enterprise'` the planner estimates `0.00083 × 100000 ≈ 83` rows (actual: 100). That's good enough.

**How it estimates combined conditions**: for `WHERE x = 1 AND y = 2` it **multiplies** the selectivities, assuming the columns are **independent**. That's where it goes wrong with **correlated columns**.

#### Failure 1: stale statistics
Statistics are a **snapshot** from the last ANALYZE. Autovacuum re-runs ANALYZE when ~10% of the table has changed (`autovacuum_analyze_scale_factor = 0.1`), but after a **bulk load, a big backfill, or a mass status change**, queries run in between get estimates for the *old* data.

Verified (autovacuum off): 100k rows with 100 `enterprise`, ANALYZE, then insert **200,000** `enterprise` rows without ANALYZE:
```
WHERE plan = 'enterprise'
→ estimated rows=302, actual rows=200100      ← 660× off
```
A 660× error makes the planner pick plans designed for a few hundred rows: a nested loop join instead of a hash join, an index scan instead of a seq scan, a sort in memory that spills. Queries go from milliseconds to minutes. **Fix**: run `ANALYZE table` right after bulk loads and migrations or backfills (put it in the migration script), and tune autoanalyze for big tables (`ALTER TABLE ... SET (autovacuum_analyze_scale_factor = 0.01)`).

Detecting it: `EXPLAIN (ANALYZE)` shows `rows=` estimate vs actual. **An order-of-magnitude mismatch on a scan node means a statistics problem.** Also `SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze FROM pg_stat_user_tables`.

#### Failure 2: insufficient statistics (skewed data)
The MCV list and histogram have at most `default_statistics_target` entries (**100** by default). With a column like `tenant_id` across 50,000 tenants where a few tenants own 30% of rows, 100 MCV slots may miss medium-sized tenants, and their estimates fall back to an "average" guess. Fix: raise the target **for that column** (more sampling, bigger MCV list and histogram, slightly slower ANALYZE and planning):
```sql
ALTER TABLE invoices ALTER COLUMN tenant_id SET STATISTICS 1000;
ANALYZE invoices;
```

#### Failure 3: correlated columns, fixed with extended statistics
`city` and `zip` aren't independent: the zip **determines** the city. The planner multiplies anyway: P(city = 'city_7') × P(zip = 'zip_7_3') = 1/100 × 1/1000 = 1/100,000 → **1 row**.

Verified on PG 17 (100k rows, 100 cities, 1,000 zips):
```
WHERE city = 'city_7' AND zip = 'zip_7_3'
before:  estimated rows=1,   actual rows=100      ← 100× underestimate
CREATE STATISTICS st_city_zip (dependencies, ndistinct) ON city, zip FROM addresses;
ANALYZE addresses;
after:   estimated rows=100, actual rows=100      ✅
pg_stats_ext.dependencies: {"3 => 2": 1.000000}   ← "column 3 (zip) fully determines column 2 (city)"
```
Extended statistics kinds:
- `dependencies`: functional dependencies (zip → city), fixes `AND` estimates;
- `ndistinct`: distinct counts of column **combinations**, fixes `GROUP BY city, zip` estimates;
- `mcv`: most-common **combinations**, the strongest option for skewed correlated data.

Underestimates are the dangerous direction: "1 row expected" makes the planner choose a **nested loop**, which runs the inner side once per outer row. With 100k actual rows, that's 100k index lookups instead of one hash join.

#### Failure 4: generic plans for prepared statements (item 7 above)
Drivers and ORMs often use **prepared statements**, especially with pooling. Postgres plans the first 5 executions with the actual parameter values (**custom plans**). After that, it may switch to a cached **generic plan** that ignores the value and uses an **average** estimate, if the generic plan doesn't look more expensive.

Verified with the skewed `plan` column (after the insert: `enterprise` = 66%, `pro` ≈ 3%):
```
custom plan, 'pro'        → Bitmap Index Scan (est. 10,680 rows)   ✅ right for a rare value
custom plan, 'enterprise' → Parallel Seq Scan (est. 117,676 rows)  ✅ right for a common value
generic plan (any value)  → Bitmap Index Scan, est. rows=100,000 (= total / n_distinct) for BOTH values
```
The generic plan uses the same strategy for every value. On skewed data, that's wrong for some of them. Symptom: "the query is fast in psql (custom plan), but slow from the app" or "it became slow after a few executions". Fixes: `SET plan_cache_mode = force_custom_plan` for that session or role (or per transaction), avoid server-side prepared statements for that query, or restructure (e.g. a partial index for the rare values).

#### Statistics cheat sheet
```sql
-- what the planner knows about a column
SELECT null_frac, n_distinct, most_common_vals, most_common_freqs, histogram_bounds, correlation
FROM pg_stats WHERE tablename = 'invoices' AND attname = 'tenant_id';

-- when were stats last refreshed, how much changed since
SELECT relname, last_analyze, last_autoanalyze, n_mod_since_analyze FROM pg_stat_user_tables ORDER BY n_mod_since_analyze DESC;

ANALYZE invoices;                                                      -- refresh now (cheap, sample-based)
ALTER TABLE invoices ALTER COLUMN tenant_id SET STATISTICS 1000;       -- more detail for a skewed column
CREATE STATISTICS ... (dependencies, ndistinct, mcv) ON a, b FROM t;   -- correlated columns
```

---

## 5. Reading EXPLAIN (ANALYZE, BUFFERS)

```
Limit  (cost=0.43..12.1 rows=20 width=64) (actual time=0.05..0.31 rows=20 loops=1)
  Buffers: shared hit=24
  ->  Index Scan using idx_tickets_tenant_status_created on tickets ...
        Index Cond: ((tenant_id = 42) AND (status = 'open'))
        Rows Removed by Filter: 0
```

What to look at:
- **estimated rows vs actual rows**: an order-of-magnitude mismatch leads to a bad join strategy. Fix the statistics.
- **`loops`**: actual time is *per loop*. A nested loop with 50k loops × 0.1 ms = 5 s.
- **`Buffers: shared read`** means disk or OS cache reads. `hit` means shared buffers. Lots of reads on a hot path means the working set doesn't fit in memory.
- **`Rows Removed by Filter`** is high: the index narrows too little. Add the filter column to the index.
- **Sort Method: external merge Disk**: `work_mem` is too small for this sort, or you need an index matching the ORDER BY.
- Node types:
  - `Seq Scan`: full table read.
  - `Index Scan`: walks the index, then fetches heap rows (random I/O).
  - `Index Only Scan`: reads only the index (plus the visibility map).
  - `Bitmap Index Scan` + `Bitmap Heap Scan`: collects TIDs, sorts them by page, reads pages in order. Good for medium selectivity and for combining indexes (BitmapAnd/Or).
- Join algorithms:
  - **Nested Loop**: good when the outer side is small and the inner side has an index.
  - **Hash Join**: builds a hash table on the smaller side. Good for large unsorted equi-joins. Needs `work_mem`.
  - **Merge Join**: both inputs sorted on the join key. Good for large pre-sorted inputs.

⚠️ `EXPLAIN ANALYZE` **executes** the query. Wrap DML in `BEGIN; ... ROLLBACK;`.

---

## 6. Write cost of indexes

- Every index adds work to each INSERT (and to UPDATEs that touch indexed columns), increases WAL volume and replication lag, and takes space in shared buffers.
- **HOT updates** (Heap-Only Tuple): if an UPDATE doesn't change any indexed column and the page has free space, PG skips the index updates. Over-indexing hot, frequently updated columns (like `updated_at`) **kills HOT**. Lower `fillfactor` (e.g. 80–90) on update-heavy tables to leave room for HOT.

---

## 7. Pagination at scale

```sql
-- OFFSET: scans & discards; page 10,000 is slow; unstable under inserts
SELECT * FROM events ORDER BY created_at DESC LIMIT 50 OFFSET 500000;

-- Keyset / seek: O(log n) per page, stable
SELECT * FROM events
WHERE (created_at, id) < ($lastCreatedAt, $lastId)   -- row-value comparison, tiebreaker on id
ORDER BY created_at DESC, id DESC
LIMIT 50;
-- index: (created_at DESC, id DESC)
```

---

## 8. ORM-specific performance traps (Sequelize / TypeORM / Prisma)

- **N+1**: loading 100 invoices and then lazily loading each client. Use `include` (JOIN) or batched `WHERE id IN (...)` (DataLoader pattern).
- `include` with `hasMany` + `limit`: Sequelize generates subqueries or cartesian explosions. Use `separate: true`, or two queries.
- Model hydration overhead: `raw: true` for read-heavy endpoints.
- `SELECT *`: specify `attributes`, which also enables index-only scans.
- Missing FK indexes: Postgres **doesn't** index foreign key columns automatically. Joins and `ON DELETE CASCADE` then do seq scans on the child table.
- `count(*)` on huge tables for pagination UI is slow (MVCC means no cached count). Use estimates (`reltuples`) or "has next page" (fetch `limit + 1`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [The WithAll query scope and its filters](../../docs/humans/concepts/domain-payments/with-all-scope.md): The Payment WithAll Sequelize scope builds queries from a filters object with optional joins, which is the ORM query pattern this section covers. [`PaymentScope`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L29), [`Payment`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L23)
<!-- theory-links:end -->

---

## 9. Full-text search vs Elasticsearch

- Postgres FTS (`tsvector`, GIN, `ts_rank`) plus `pg_trgm` covers most product-search needs without new infrastructure.
- Elasticsearch/OpenSearch is worth it for: relevance tuning, fuzzy matching across many fields, aggregations/facets at scale, and high search QPS isolated from the OLTP DB. The cost: a second source of truth, sync through CDC or outbox, eventual consistency, and operational load.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ShopProductSearchService`](../../packages/backend/libs/domains/discovery/application/shop-product-search.service.ts#L19): ShopProductSearchService implements Postgres FTS plus trigram fallback for shop product search. _(shop-product-search.service.ts)_
> - [`ElasticsearchService`](../../packages/backend/libs/infrastructure/elasticsearch/elasticsearch.service.ts#L16): ElasticsearchService handles product indexing and search, the Elasticsearch side of the FTS-vs-ES split. _(elasticsearch.service.ts)_ · [elasticsearch](../../docs/humans/concepts/platform-elasticsearch/elasticsearch.md)
> - [`AvailabilityIndex`](../../packages/backend/libs/domains/fulfilment/infra/availability-index.ts#L31): AvailabilityIndex manages the Elasticsearch pickup_availability index with geo search. _(availability-index.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: Walk me through how you would reduce DB load with indexes.**
Start from `pg_stat_statements` sorted by total execution time, which surfaces high-frequency queries doing seq scans or filtering a lot of rows. For each one, run `EXPLAIN (ANALYZE, BUFFERS)` on prod-sized data, design a composite index (equality columns first, then range or sort columns, `INCLUDE` for covering where it helps), build it with `CREATE INDEX CONCURRENTLY`, and verify the drop in mean time and in total DB CPU/IO. Also check for unused indexes, so writes don't pay for indexes nobody uses.

**Q: Why does a composite index only work for the leftmost prefix?**
Entries are sorted by `a`, then by `b` only within equal `a`, like a phone book sorted by (last name, first name). Rows with a given `b` are scattered across every `a` group, so there's no position to seek to. You can only scan the whole index. After a range condition on a column, later columns can only filter, not narrow. Equality columns go first and the range column last.

**Q: What's an index-only scan, and why might it still hit the table?**
All needed columns are in the index (key or `INCLUDE`), so heap reads can be skipped. But visibility (MVCC) info lives only in the heap, so Postgres checks the visibility map: pages marked all-visible by VACUUM are trusted, and any modified page means a heap fetch. On write-heavy tables `Heap Fetches` climbs until vacuum runs, so tune autovacuum for that table.

**Q: Why would Postgres choose a seq scan over an available index?**
It reads 8 KB pages, not rows. When matching rows are scattered, even 1–3% of rows can touch almost every page, so the index saves no I/O and adds random reads. It also happens with small tables, wrong estimates from stale or insufficient statistics, or generic prepared-statement plans. Check estimated vs actual rows in `EXPLAIN ANALYZE`.

**Q: What are planner statistics, and what goes wrong with them?**
`ANALYZE` samples the table and stores, per column, the null fraction, distinct count, most-common values with frequencies, a histogram, and physical-order correlation (`pg_stats`). The planner multiplies selectivities assuming independent columns. Things break with stale stats after bulk loads (run ANALYZE), skewed columns (raise `SET STATISTICS`), and correlated columns (`CREATE STATISTICS` with dependencies/ndistinct/mcv). Underestimates are the dangerous direction, because they lead to nested loops over huge row counts.

**Q: Composite index `(a, b)`. Does `WHERE b = 1` use it?**
Generally no, because it isn't a leftmost prefix (PG 18 skip scan can help when `a` has few distinct values). Create `(b)` or `(b, a)` depending on the queries.

**Q: Why might Postgres pick a seq scan even though there's an index?**
Low selectivity, a small table, stale or misleading statistics, a function or cast on the column, or a type mismatch. Check estimated vs actual rows in `EXPLAIN ANALYZE`.

**Q: How do you add an index to a 500M-row table in production?**
`CREATE INDEX CONCURRENTLY`: it doesn't block writes, takes longer, and can't run inside a transaction. If it fails it leaves an `INVALID` index that you drop and retry. Set `lock_timeout`, watch replication lag and I/O, and run it off-peak.
