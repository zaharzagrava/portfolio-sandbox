# Fix: "Topic creation errors" in the sharded run

## What went wrong
- The test message broker (Redpanda, container marketplace_test_kafka) refuses to make a new topic once it has a certain number of partitions.
- The broker log said: "Refusing to create 1 partitions as total partition count 205 would exceed FD limit 204" (error topic_invalid_partitions_fd_limit).
- So the limit is not a setting of the broker. The broker works it out from how many files the container may keep open (1024 by default, about 5 per partition, minus its own needs = 204).
- With five shards each making their own s1-, s2-, ... topics on top of the normal ones (about 150 partitions already, plus internal ones), the limit was reached and every later topic creation failed. The tests only fail when they need a topic that was not made.

## Fix
- docker-compose.test.yaml: the test_kafka service now has `ulimits: nofile 262144` (same as the ClickHouse service). This lifts the cap to many thousands of partitions.
- The Kafka container was recreated ONCE with `docker compose -f docker-compose.test.yaml -p marketplace_test up -d --no-deps test_kafka`. No other container was touched. Topics survived the restart.
- Nothing changed in the tests or in the unsharded behaviour; the topic names and partition counts are the same.
- Anyone who recreates the stack from the compose file gets the fix. A Kafka container created from the old file still has the low cap.

## Check (shard 1 only, shard-prepare.sh 1 then shard-run.sh 1 1 <files>)
- The 25 files with this error: 21 pass fully, 4 still have failures, none of them about topics:
  - consumer-idempotency (3 tests), read-your-writes (2 tests), search-admin (2 tests): Redis "Stream isn't writeable" / connection errors and related.
  - trending-stream (3 tests, "aggregate store fails" group): time out after about 75 s.
  These belong to other streams (Redis / timing), not to the broker.
- The only "Topic creation errors" line left in the log comes from trending-platform's deliberate break-the-broker test, which passes.
