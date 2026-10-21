# Projection and related test fixes (shard 7)

Fixed
- consumer-idempotency: tests started side by side all create the same helper tables at once, and the database sometimes refuses the second "create if missing". Fix: the table creation helper (libs/infrastructure/events/testing/fixture-consumers.ts) now lines the calls up one behind another. Second cause: the file kept one shared database connection that belonged to whichever app booted last; when a test stopped its own app, the connection closed under the others. The stop step now hands the connection to a live app first. 15 of 15 pass.
- consumer-failures: the outage test wrote to and read from Redis database 0, while the shard uses its own database number. Now it uses the number at the end of REDIS_URL. 16 of 16 pass (the cause of the empty list was not proven; likely a flush from another process on database 0).
- analytics-store: the test expected plain topic and group names; the shard adds a prefix. The expectations now use shardName. 9 of 9 pass.

Not fixed (time ran out)
- read-your-writes: counts the Redis server-wide "get" counter before and after; any other process on the same Redis server adds to it. Needs a per-client count instead. 
- search-admin: fails in shard 7 even alone after earlier files; reset step deletes an index that is missing ("no such index s7-products_m1_init"), and a Redis client reports "Stream isn't writeable". Not investigated further.
- jobs-observability and leaderboard-read passed in a combined run.
