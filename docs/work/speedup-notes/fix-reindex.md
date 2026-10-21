# Reindex test: searches during a run

Cause (most likely, not reproduced): the test sends a search every ~20 ms while a rebuild runs, all as one anonymous caller.
Search allows 120 calls a minute per caller. On a quiet machine the run lasts about 3 s (~80 searches), close to the limit;
in a full 5-shard run the machine is busy, the rebuild takes longer, more searches are sent, and the limit answers 429,
so "every answer is 200" is false. All names in the test are already shard-prefixed; no shared wildcard was found.
Two copies on shards 7 and 8 at once both passed, so cross-shard interference is not the cause.

Fix: the polling searches are spread over 10 admin users (limit is per user). The check itself (all 200, total never below 300) is unchanged.
