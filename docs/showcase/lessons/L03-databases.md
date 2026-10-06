# L03 — Databases (Postgres, Redis) → where it's used

| Topic (notes 03/01–04) | Implemented in | Status |
|---|---|---|
| `pg_stat_statements`, unused/redundant index queries | SD-33 "DB insights" admin endpoint + runbook | planned |
| Composite index order (leftmost prefix), `shopId`-leading indexes | SD-02 migrations | planned |
| Covering indexes (`INCLUDE`) for index-only scans | SD-19 `Order(userId, createdAt) INCLUDE (status, total)` for order history | planned |
| Partial indexes | SD-21 `UNIQUE(eventId, seatId) WHERE status='BOOKED'`; SD-29 `WHERE status='QUEUED'` | planned |
| Expression indexes | SD-39 `lower(email)` | planned |
| Keyset pagination | existing README #10; all new list endpoints | planned |
| ORM traps (N+1, unbounded includes) | SD-04 DataLoader; review in each section | planned |
| Postgres FTS vs ES | SD-37 shop-admin search (FTS); SD-43 hybrid BM25 | planned |
| MVCC/VACUUM, HOT updates (`fillfactor`) | SD-29 `Job` table fillfactor=70 + autovacuum tuning | planned |
| Isolation levels; **write skew with SERIALIZABLE + retry** | SD-02 "shop must keep ≥ 1 owner" (concurrent owner removals) | planned |
| Lost-update prevention (atomic update, OCC, `FOR UPDATE`, conditional) | SD-19, SD-21, SD-22 (+ existing OCC #6) | planned |
| Row locks, `SKIP LOCKED`, advisory locks | SD-29, SD-21 GA variant | planned |
| Deadlock avoidance (sorted lock order) | SD-19 multi-item, SD-20 transfers | planned |
| DDL lock safety (`lock_timeout`, `CONCURRENTLY`) | CONVENTIONS + SD-02 migrations | planned |
| Expand/contract zero-downtime migration + batched backfill | SD-02 (`shopId` backfill), SD-20 (ledger partitioning) | planned |
| Connection pooling (PgBouncer transaction mode, RDS Proxy) | existing PgBouncer; O-03 RDS Proxy; SD-02 `SET LOCAL` compatibility | planned |
| Read replicas & replica lag (read-your-writes) | F-05 `minVersion`; Sequelize `replication` config for read-heavy admin paths | planned |
| Partitioning | SD-29 jobs (daily), SD-20 ledger (monthly), SD-14 chat (monthly), SD-22 bids | planned |
| Sharding strategy (shopId / cells) | SD-02 `ShopDirectory` | planned |
| IDs: UUIDv7, Snowflake/timeuuid, ID ranges | existing UUIDv7; SD-09/11 timeuuid; SD-08 ID leases | planned |
| Temporal / bitemporal | SD-41 | planned |
| CDC (Debezium) | F-05 | planned |
| Redis data structures (ZSET, GEO, bitmap, streams, HLL, hashes) | SD-11/18/21 ZSET; SD-23 GEO; SD-21 bitmap; F-03 streams; SD-09 HLL | planned |
| Cache-aside, write-behind, SWR, stampede, avalanche, penetration, hot & big keys | SD-34 | planned |
| Eviction policies | O-03 ElastiCache param group (`allkeys-lfu` for cache cluster, `noeviction` for state cluster — two clusters) | planned |
| Distributed locks + fencing tokens | SD-34, SD-21 | planned |
| Rate limiting in Redis (Lua) | SD-28 | planned |
