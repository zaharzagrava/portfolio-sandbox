# Shard second pass: spec files

With TEST_SHARD unset every name below is the same as before. With a shard, specs now use the same shared-service names as the code.

- Realtime specs (publisher, authorization, fanout, replay, stream): the Redis channel they check subscribers on is built with `channelName(topic)` instead of the text `rt:c:`.
- Search specs (synonyms, reindex, admin, projection): `'products'` is now `PRODUCTS_ALIAS`; the legacy index `products_m0_legacy` is `shardName(...)`. The pickup projector spec checks `AVAILABILITY_INDEX`.
- SQS specs (task-queue, outbox-tasks, observability): queues created by name are created as `shardName(name)`; the code under test still gets the plain name and adds the prefix itself, so metrics labels stay plain.
- shop-cells: the second Postgres database gets `_s<n>` added under a shard.
- versioned-sinks: the keyspace file is rewritten to `CASSANDRA_KEYSPACE` (same as scripts/cql/migrate.ts).
- media-processing lambda spec: bucket is `MEDIA_BUCKET` when set, else the old literal.
- Found by the sweep: `auctions/testing/auction-app.ts` `flushAll()` ran Redis FLUSHALL, which empties every Redis database (other shards too). Under a shard it now runs FLUSHDB; unset keeps FLUSHALL.
- Checked, no change: all `flushdb`/`keys('*')` uses (per Redis database), Kafka clients (only two `new Kafka`, both wrapped), `media_bucket` literals (config validation only), `collab:revoke` (already shardName), aggregate type `'products'` (not an index).
- Not touched: outbox-cdc (one shard only), video-delivery regex.
- tsc passes. No suites were run.
