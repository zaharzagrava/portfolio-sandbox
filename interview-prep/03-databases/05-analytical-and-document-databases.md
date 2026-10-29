# Analytical and document databases: ClickHouse, Redshift, Snowflake, MongoDB

When to leave Postgres, and for what. Postgres stays the default source of truth; these four solve specific problems it handles badly at scale.

---

## 1. Two kinds of workload

| | OLTP (transactions) | OLAP (analytics) |
|---|---|---|
| Typical query | "get order 42", "insert this payment" | "revenue per country per day, last 90 days" |
| Rows touched per query | a few, by key | millions to billions, a few columns |
| Writes | many small, updates and deletes | big batches, mostly append |
| Storage layout | **row-oriented**: a whole row stored together | **column-oriented**: each column stored together, heavily compressed |
| Examples | Postgres, MySQL, MongoDB, DynamoDB | ClickHouse, Redshift, Snowflake, BigQuery |

**Why columnar is fast for analytics:** `SUM(amount) GROUP BY country` reads only the `amount` and `country` columns, not whole rows. Values in one column look alike (same type, repeated countries), so they compress 5–20x. Less disk read, and the CPU processes a column in tight vectorized loops.

**Why columnar is bad for OLTP:** updating one row means touching every column file; point lookups and single-row updates are slow or limited.

---

## 2. The four

### ClickHouse
- **What**: open-source columnar database built for **fast analytics on fresh data**. Self-hosted or ClickHouse Cloud.
- **Strengths**: ingest millions of rows/s in batches; sub-second aggregations over billions of rows; `MergeTree` tables sorted by a key you choose; **materialized views** that pre-aggregate on insert (e.g. raw clicks → per-minute rollups automatically); TTL rules that delete or roll up old data.
- **Weak at**: single-row updates/deletes (they are rewrites, async), multi-row transactions, many small inserts (batch them: thousands of rows per insert), heavy joins between big tables.
- **Pick it for**: **user-facing / real-time analytics**: dashboards customers open, logs and metrics, event analytics, click/ad counting, observability.

### Amazon Redshift
- **What**: AWS's managed **data warehouse** (columnar, Postgres-flavoured SQL). Provisioned clusters or Redshift Serverless.
- **Strengths**: big joins across many business tables; integrates with S3 (Spectrum queries files in place), Glue, QuickSight; zero-ETL from Aurora/RDS.
- **Weak at**: high-concurrency, low-latency queries for end users; per-row ingestion; freshness of seconds.
- **Pick it for**: **internal BI and reporting** on AWS: finance, product analytics, analysts with SQL and BI tools, data refreshed every few minutes to hours.

### Snowflake
- **What**: cloud **data warehouse** as a service (runs on AWS/GCP/Azure). Storage and compute are **separate**: data sits in cloud storage; you start "virtual warehouses" (compute clusters) of different sizes that suspend when idle.
- **Strengths**: near-zero ops; many teams query the same data with separate compute (finance's heavy job doesn't slow product's dashboards); time travel (query data as of an earlier point), zero-copy clones, data sharing between companies; semi-structured JSON (`VARIANT`).
- **Weak at**: user-facing low-latency queries; cost grows with compute time if warehouses are left running.
- **Pick it for**: the **company-wide warehouse** when you want minimal ops and many teams. (BigQuery is the Google Cloud equivalent, serverless, priced per data scanned.)
- **Name trap**: a "**Snowflake ID**" is something else: Twitter's 64-bit ID scheme (timestamp + machine id + sequence) used for sortable unique IDs (feeds, chat messages). Not the database.

### MongoDB
- **What**: **document database** (OLTP). Stores JSON-like documents (BSON) in collections; flexible schema; Atlas is the managed service.
- **Strengths**: a whole aggregate in one document (an order with its line items, a product with variable attributes) read and written in one go; built-in **sharding** for horizontal scale; secondary indexes; aggregation pipeline; change streams (CDC). Multi-document ACID transactions exist (since 4.0), but are slower and the design goal is "one document = one unit of change".
- **Weak at**: relations and joins across collections (`$lookup` exists but isn't the model), strict cross-entity constraints, financial ledgers (Postgres is the safer default).
- **Pick it for**: data whose shape varies a lot per record (product catalogs, CMS content, user-generated forms, event payloads), document-shaped aggregates read by id, teams that need easy horizontal scale.
- **"Do companies outgrow Mongo?"** Not as a rule: it's an OLTP store with native sharding, and large companies run on it at scale. It isn't a jack-of-all-trades either: it doesn't replace a columnar store for analytics or a search engine. Mongo shops add the same specialists Postgres shops add (a warehouse, ClickHouse, OpenSearch, Redis). The usual reason to move a domain *off* Mongo is relational needs: many joins, constraints across entities, money moving between records in one transaction. Interview reality: **Postgres + `JSONB`** covers most "flexible schema" needs; say Mongo only with a reason (shape varies wildly, sharding needs, team expertise).

---

## 3. Choosing

| Need | Default | Why not the others |
|---|---|---|
| Source of truth, transactions, money | **Postgres** | Mongo possible but weaker on relations/constraints; analytics DBs aren't transactional |
| Varying-shape documents read by id | **Postgres JSONB**, or **MongoDB** if shape varies wildly or you need sharding | |
| Customer-facing dashboards on fresh, huge event data (seconds) | **ClickHouse** | warehouses are too slow/costly per query at high concurrency |
| Logs, metrics, traces at scale | **ClickHouse** (or managed: Datadog, OpenSearch for full-text logs) | |
| Internal BI, finance reports, joins across all company data | **Snowflake** or **Redshift** (BigQuery on GCP) | ClickHouse is weaker at big joins and BI tooling |
| Ad-hoc SQL over raw files in S3, rarely | **Athena** (pay per TB scanned) | no cluster to run |

**Typical company setup**: Postgres (OLTP) → CDC (Debezium/DMS) or nightly export → **warehouse** (Snowflake/Redshift) for internal reporting; **ClickHouse** only if the product itself shows analytics to customers in real time. Using both a warehouse and ClickHouse is common; using Redshift **and** Snowflake together is not (they overlap).

**Throughput and prices** for all of these (plus Postgres, DynamoDB, Redis, Scylla, S3/Athena) side by side: [06 Database throughput and costs](06-database-throughput-and-costs.md).

---

## 4. Where they fit in the practice tasks

| Task | Postgres | ClickHouse | Warehouse (Snowflake/Redshift) | MongoDB |
|---|---|---|---|---|
| arch-02 URL shortener | links + minute rollups (tiers, partitions) | rollups if they outgrow Postgres; raw click log if the product shows every click | marketing BI across customers | — |
| arch-17 metrics and logging platform | — | **core store** for logs/metrics | — | — |
| arch-18 ad click aggregation / top-K | billing totals | **core store** for counts | finance reporting | — |
| arch-33 earnings reporting without hurting OLTP | source of truth | real-time partner dashboards | **core**: replica → CDC → warehouse | — |
| arch-43 audit log | write path | search/analytics over years of events | compliance reports | — |
| arch-44 GDPR erasure | source of truth | erase from copies | **copies must be erased too** | erase from copies |
| arch-07 autocomplete, arch-13 flash sale (product catalog) | orders, inventory | — | — | catalog with varying attributes (alternative to JSONB) |
| arch-21 collaborative editing | metadata, permissions | — | — | document snapshots (option) |
| arch-22 AI assistant | chunks + pgvector | usage/cost analytics | — | conversation history (option) |
| fin-20 Postgres + secondary store in sync | source of truth | — | — | the secondary store in that task |

No single task needs all four. The pattern repeats:
- **Postgres** is the source of truth.
- **ClickHouse** appears when **customers** see analytics in near real time.
- **A warehouse** appears when the **company** analyzes everything.
- **MongoDB** is an option for document-shaped data, rarely a requirement.
