# arch-32. Keeping a search index in sync with Postgres

*Data · Medium*

## The question

"Our second-hand marketplace has 40M active listings in Postgres, with ~200 listing writes/s (new listings, price changes, sold). Buyer search runs on OpenSearch at ~3k queries/s: full text, facets, distance and typo tolerance. Today the API writes Postgres and then calls OpenSearch in the same request. Sold items stay in search for hours, and some new listings never appear. Fix the sync and tell me how you'd rebuild the index."

**Then:** "The change-capture consumer you introduced was down for 6 hours over the weekend. What happened to Postgres, and how do you recover?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Acceptable lag? → assume: a few seconds for price and sold; a listing shown as available but already sold is the main complaint.
- Who writes listings? → assume: the API, but also admin scripts, a bulk-import job and a moderation service. That decides the capture mechanism.
- Postgres setup? → assume: RDS PostgreSQL; logical replication can be enabled (`rds.logical_replication = 1`).
- Document shape? → assume: denormalized: listing + seller rating + category path + location; ~2 KB each, so ~80 GB of primaries for 40M docs, plus a replica.
- Seller-side "my listings" screen? → assume: stays on Postgres; one seller's listings are a selective, indexed query.
- Can the UI tolerate small lag? → assume: yes, as long as the item page and checkout read Postgres.

## Design

**Rule: one writer. Business code writes only Postgres; OpenSearch is derived.**

1. **Remove the dual write** from the request path.
2. **Capture changes from the WAL (CDC).** A logical replication slot with `pgoutput`, read by Debezium (Kafka Connect, or Debezium Server with a Kinesis sink). CDC sees every writer, including scripts and the moderation service. Publication limited to `listings, sellers, listing_photos`.
3. **Indexer.** A change only says *which listing* is affected (a seller change maps to that seller's listings). The indexer batches dirty ids for ~1 s, reads the **current** rows from Postgres, builds documents, and sends a `_bulk` request:
```json
{ "index": { "_index": "listings", "_id": "123", "version": 9876543210, "version_type": "external" } }
```
`version` = the change's commit LSN as a number (or a per-row `version` column). OpenSearch rejects writes with a version not greater than the stored one, so a late or duplicate change can't overwrite newer data. A row that no longer exists, or is sold, becomes a delete.
4. **Reads.** Search returns ids and display fields. The item page and checkout read Postgres, so a stale "available" in results never sells a sold item; the results page re-checks status for the 20-50 ids it shows (one indexed `WHERE id = ANY($1)` query) and hides sold ones.
5. **Reindex** for mapping changes or recovery: create `listings_v8`, backfill from a Postgres snapshot (keyset batches on a reader), while the indexer writes to both `v7` and `v8`; compare counts; swap the alias `listings` atomically; keep `v7` a day for rollback.
6. **Monitoring:** slot lag in bytes (`pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)` from `pg_replication_slots`, or RDS `OldestReplicationSlotLag`), indexer lag in seconds, bulk errors, and a nightly count comparison per category.

## Deep dives

**1. Why the dual write loses data for hours.** No transaction spans Postgres and OpenSearch. A failed or timed-out index call after commit leaves the index stale until something else touches that listing. Concurrent requests interleave: A writes PG, B writes PG, B indexes, A indexes, so the index keeps A's older state. Scripts that update Postgres directly never index at all. Retries don't fix interleaving.

**2. CDC vs outbox.** An outbox gives clean domain events, but only from code paths that write it; scripts and the moderation service would bypass it. CDC captures every committed change in commit order. Its costs: the slot must be operated, and consumers depend on table structure. Using CDC only as a "listing X changed" signal and rebuilding through SQL keeps that dependency small.

**3. Deletes and late events.** OpenSearch remembers a deleted document's version only for `index.gc_deletes` (default 60 s). A late index operation after that can resurrect a sold listing. Because the indexer always re-reads the current row, a late change for a sold or deleted listing produces a delete again, not an old document. Alternative: index sold listings as `status: sold` and filter them out, which keeps the version.

## Traps

- "Wrap Postgres and OpenSearch in one transaction" or "just retry the index call".
- Indexing from event payloads instead of the current row: out-of-order events write old data.
- Ordering by `updated_at` from different app servers instead of LSN or a version column.
- Ignoring replication-slot lag: a stuck consumer fills the primary's disk.
- No full-rebuild path: the first incident has no recovery.
- Checkout trusting the index's "available" field.

## Say it (60–90 s)

The root cause is a dual write: Postgres and OpenSearch are written separately, so failures and concurrent requests leave the index with old data, and scripts never update it at all. The fix is one writer. The API writes only Postgres, and the index becomes derived data. I capture changes from the WAL with a logical replication slot and Debezium, because CDC sees every writer, including scripts and the moderation service. Each change only tells the indexer which listing is affected; the indexer batches ids for a second, reads the current rows, and bulk-indexes them with external versioning based on the commit position, so an older version can never overwrite a newer one and redeliveries are harmless. Sold or missing rows become deletes. The item page and checkout read Postgres, and the results page re-checks status for the ids it shows, so a stale result never sells a sold item. To rebuild, I create a new index, backfill it from Postgres while the indexer writes to both, compare counts and swap the alias. I monitor slot lag in bytes, indexer lag in seconds, and compare counts nightly.

## Follow-ups

**Q:** Then: the consumer was down 6 hours. What happened, and how do you recover?
**A:** Postgres kept all WAL since the slot's confirmed position, so disk use grew for 6 hours (storage autoscaling can hide it until it can't). If `max_slot_wal_keep_size` (Postgres 13+) was set and exceeded, the slot was invalidated: Postgres is safe, but the consumer lost its place. Slot intact: restart and catch up; the dirty-id batching means each listing is reindexed once, not once per change. Slot invalidated: create a new slot, then run the full reindex into a new index and swap the alias. Prevention: alert on slot lag, set `max_slot_wal_keep_size`, use Debezium heartbeats so a slot on quiet tables still advances. Whether a slot survives a database failover depends on the Postgres version (17 added slot sync to standbys) and the managed service, so plan a re-snapshot after failover.

**Q:** Why not index straight from Debezium's row images, without reading Postgres?
**A:** The document joins seller, photos and category, which a single row change doesn't contain. Re-reading is ~200 small queries/s on a reader, cheap at this volume, and it makes ordering a non-issue.

**Q:** How do you know the index is complete?
**A:** A nightly job compares counts per category and day bucket between Postgres and OpenSearch and re-indexes any bucket that differs.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
