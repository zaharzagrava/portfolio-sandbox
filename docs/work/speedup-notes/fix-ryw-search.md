# read-your-writes and search-admin fixes (shard 7)

Fixed
- read-your-writes (two checks: AS-77 and AS-78): they counted the Redis server-wide "get" counter before and after. Other shards on the same Redis server add to that counter. Now the test wraps the "get" and "mget" calls of this app's own Redis connection and counts only those. The claim is the same: the route made zero reads of the checkpoint store. 17 of 17 pass.
- search-admin: one earlier test cuts the Redis connection on purpose. That connection refuses commands while it is down and for a moment after the line is restored ("Stream isn't writeable"). The reset step (libs/domains/discovery/testing/search-app.ts, resetSearch) restored the line but did not wait for the connection to come back, so the next test could hit the half-closed one. The reset step now waits until the connection answers a ping (up to 10 s) before going on. 5 of 5 pass alone.

Not reproduced
- The "no such index s7-products_m1_init" error in the reset step did not appear in my run of this file alone; the delete there already ignores missing indexes. If it comes back in a full run, the likely cause is another file removing the index at the same moment, which needs a full-run log to confirm.
