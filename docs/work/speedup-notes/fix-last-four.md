# The last four failures: NOT finished (no cause found, no change made)

Tried: rebuilt the 5 lists with balance.py (the old ones in /tmp/prof/l5 are gone). trending-platform and launch-events-queue sit in list 4 (places 6 and 29), load-shedding in list 5 (place 28), launch-events-operations in list 3 (place 68).
Started on shard 9 the 29 files of list 4 up to launch-events-queue, and on shard 10 the 28 files of list 5 up to load-shedding. The machine was so busy (other shards) that files took 2 to 8 times longer than normal (one file 130 s), so after 16 minutes only the first 4 to 8 files of each run were done, none of the target files was reached. Nothing failed except notifications-delivery AS-49 ("queued" instead of "sent"), which is the already known send-budget timing case, not one of the four.
Not done: list 3 run for launch-events-operations.
Things read that matter for the next try:
- MetricsRegistry (libs/common/telemetry/metrics-registry.ts) keeps its numbers in one process-wide table. trending's check "labels carry no identifiers" reads ALL label sets of five trending_* metrics, so any late write from an earlier file's app that is still running (a consumer or timer that survived) pollutes it after the per-file reset. Look for such a leftover first.
- The shard 9 run printed endless kafkajs "Closed connection" retries (retry 10 and more): an earlier file leaves a Kafka client retrying after its app closed. That is a leftover background worker and is the best lead for the three log/metric failures.
- launch-events-queue: git diff 839860cf touches 8 launch-events files (holds, organizer, seatmap, live-delivery, live-history, live-reactions, live-streams), not the queue spec itself; not analysed.
Next step: rerun when the machine is quieter, with TEST_LOGS=1, and find which file starts the kafkajs retries (the log line before the first "Closed connection").
