# arch-49. Postgres and a secondary store in sync

*Data · Hard*

## The question

"Postgres is the source of truth for leases, charges and payments. The tenant mobile app reads a denormalized 'tenant home' document from MongoDB (balance, next charge, recent payments; ~5 KB each, 300k tenants), and a Redis cache sits in front of the landlord dashboard. Today the API writes Postgres, then Mongo, then deletes the Redis key. Tenants sometimes see a wrong balance for hours. Fix it."

**Then:** "The change-capture consumer you introduced was down for 6 hours over the weekend. What happened to Postgres, and how do you recover?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Acceptable staleness? → assume: tenant home within seconds; dashboard within a minute.
- Who writes to Mongo today? → assume: only the API; going forward, only the sync process.
- Who writes to Postgres? → assume: the API, but also admin scripts, migrations and a second service: that's important for picking a mechanism.
- Postgres setup? → assume: RDS/Aurora PostgreSQL; logical replication can be enabled (`rds.logical_replication = 1`).
- Write volume? → assume: ~50 writes/s, ~500/s on the 1st.
- Can the app show freshness? → assume: yes ("updated 10 s ago").

## Design

**Rule: one writer. Only Postgres is written by the business code; Mongo and Redis are derived.**

1. **Remove the dual write.** The API writes Postgres only.
2. **Capture changes from the WAL (CDC).** A logical replication slot with `pgoutput`, read by Debezium (Kafka Connect, or Debezium Server with a Kinesis sink) or, at this volume, a small Node service using a logical replication client library. CDC sees every writer, including admin scripts and the other service. Publication limited to `leases, charges, payments, tenants`.
3. **Projector.** Each change only tells it *which tenant* is affected (`charges.tenant_id`, `payments.tenant_id`). It marks the tenant dirty, then **rebuilds** the whole document from Postgres in one REPEATABLE READ snapshot. Rebuilding from current state is simpler and self-correcting compared with applying deltas.
4. **Ordered, idempotent write to Mongo:**
```js
db.tenantHome.updateOne(
  { _id: tenantId, $or: [{ lsn: { $lt: lsn } }, { lsn: { $exists: false } }] },
  { $set: { ...doc, lsn } },
  { upsert: true })   // duplicate-key error on upsert = a newer version already stored → ignore
```
   `lsn` is the change's commit position, which only grows. An older rebuild can't overwrite a newer one, and redelivered changes after a restart are harmless.
5. **Redis.** The same stream deletes `landlord:{id}:summary` after the change commits; TTL 5 min as a safety net; single-flight on cache misses so 50 requests don't rebuild the same key.
6. **Read-your-writes.** A tenant who just paid sees the payment from the payment API response; the home document catches up within seconds.
7. **Repair path.** `rebuild(tenantId)` and `rebuildAll()` jobs (rate-limited, run on a reader). Used for initial load, after incidents, and by a nightly check that compares a hash of each Postgres-derived document with Mongo.

**Monitoring:** slot lag in bytes (`pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)` from `pg_replication_slots`, or RDS `OldestReplicationSlotLag`), projector lag in seconds, rebuild errors, nightly drift count.

## Deep dives

**1. Why the dual write produces hours of wrong data.** No transaction spans Postgres and Mongo. A crash after the Postgres commit leaves Mongo old until something else touches that tenant. Worse, concurrent requests interleave: A writes PG, B writes PG, B writes Mongo, A writes Mongo → Mongo holds A's older state indefinitely. Admin scripts that update Postgres directly never touch Mongo at all. Retries don't fix interleaving.

**2. CDC vs outbox.** An outbox gives clean domain events, but only for code paths that write it; the admin scripts and the other service would still bypass it. CDC captures every committed change in commit order. Its cost: consumers depend on table structure (a column rename can break the mapping), and the replication slot needs operating. Using CDC only as a "tenant X changed" signal and rebuilding through SQL keeps the dependency on table structure small.

**3. The cache race.** Reader R misses, reads old value from PG; writer W commits and deletes the key; R writes the old value into the cache. Mitigations: delete from the CDC stream (after commit), short TTL as a bound, and store `lsn` with cached values so an older value can't replace a newer one. Rejected: updating the cache from the API (same interleaving as Mongo).

## Traps

- "Wrap Postgres and Mongo in one transaction" or "just retry the Mongo write".
- The API updating the cache with new values instead of invalidating after commit.
- Letting any logic compute balances from Mongo: it's a read model, never a source of truth.
- Ignoring replication-slot lag: a stuck consumer can fill the primary's disk.
- No full-rebuild path: the first incident has no recovery.
- Ordering with `updated_at` timestamps from different app servers instead of LSN or a version column.

## Say it (60–90 s)

The root cause is a dual write: Postgres and Mongo are written separately, so crashes and concurrent requests leave Mongo with old data, and admin scripts never update it at all. The fix is one writer. The API writes only Postgres, and Mongo and Redis become derived data. I capture changes from the WAL with a logical replication slot, using Debezium or, at this volume, a small Node consumer, because CDC sees every writer, including scripts and the other service. Each change only tells the projector which tenant is affected. The projector rebuilds that tenant's whole document from Postgres in one snapshot and writes it to Mongo with the change's LSN, using a conditional update, so an older version can never overwrite a newer one and redeliveries are harmless. The same stream deletes the related Redis keys after commit, with a short TTL as a safety net. A tenant who just paid sees it from the payment response, so the home screen can be a few seconds behind. I keep a rebuild job for one tenant or all of them, and a nightly check that compares Postgres-derived hashes with Mongo. I monitor slot lag in bytes, because a stuck consumer makes Postgres keep WAL. And I'd ask whether Mongo is needed at all: 300k documents of 5 KB fit in a Postgres table.

## Follow-ups

**Q:** Then: the consumer was down 6 hours. What happened, and how do you recover?
**A:** Postgres kept all WAL since the slot's confirmed position, so disk usage grew for 6 hours (storage autoscaling can hide it until it can't). If `max_slot_wal_keep_size` (Postgres 13+) is set and was exceeded, the slot is invalidated: Postgres is safe, but the consumer lost its position. Recovery: if the slot is intact, restart and let it catch up (dirty-set dedup means each tenant is rebuilt once, not once per change), with the app showing "updated at"; if invalidated, create a new slot and run `rebuildAll()`. Prevention: alert on slot lag, set `max_slot_wal_keep_size`, use Debezium heartbeats so a slot on quiet tables still advances. Whether a slot survives a database failover depends on the Postgres version (17 added slot sync to standbys) and the managed service, so plan for a re-snapshot after failover.

**Q:** Why not drop Mongo?
**A:** Often the right answer: a `tenant_home` row (jsonb) updated in the same transaction as the payment removes the sync problem. Keep Mongo only if something real depends on it.

**Q:** How do you test the projector?
**A:** Testcontainers with Postgres and Mongo: apply changes, kill the consumer mid-stream, redeliver, reorder, and assert the documents match a full rebuild.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/04-redis-and-caching.md](../../03-databases/04-redis-and-caching.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
