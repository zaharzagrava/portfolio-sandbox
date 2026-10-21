# Shard isolation: inventory of names (2026-10-21, read from the code and `.env.test`)

Configurable per process through `.env.test` (so one stack can serve several shards by changing the value):
- Postgres: `DB_NAME` (clone with `CREATE DATABASE ... TEMPLATE`), port `DB_PORT`.
- Redis: the database number in `REDIS_URL` (`/0` to `/15`).
- Scylla: `CASSANDRA_KEYSPACE` (default `marketplace`); the migrations would have to run once per keyspace.
- Dynamo: `DYNAMO_TABLE_PREFIX` (`test_`); tables created once per prefix.
- ClickHouse: `CLICKHOUSE_DATABASE`.

Hard-coded or shared, not solved by a setting:
- Elasticsearch: the alias/index `products` is a literal (14 uses). Two shards on one Elasticsearch would clash.
- SQS: 58 queue sections in `infra/docker/elasticmq/elasticmq.conf`, referenced by name; `SQS_QUEUE_URL_PREFIX` is a URL prefix, not a name prefix.
- Kafka: topic names come from `init-kafka-topics.sh` and the code; no prefix setting found.
- Media bucket `MEDIA_BUCKET` is configurable; the Kafka/ES/SQS ones are not.

Consequence: the "lighter" variant (shared Kafka, Elasticsearch, SQS) needs code changes (a prefix for index, queue and topic names). The simple variant needs none:
a whole test stack per shard (compose project name + a port offset), about 5 GB each. Recommended first step: parametrize `docker-compose.test.yaml` ports by
`SHARD` and write `.env.test.<n>` per shard; then `jest --shard=i/N` per stack.

---

# Part 2: light sharding on ONE shared stack (stream 3 helper, 2026-10-21)

How it works now: several test processes share one Postgres, Redis, Kafka, Elasticsearch, ClickHouse, Scylla, Dynamo, MinIO and ElasticMQ. Each shard `n` (1 to 15) has its own names.
One environment variable, `TEST_SHARD=n` (empty or unset = normal run, every name unchanged), puts `s<n>-` in front of the names that have no setting of their own.
The code for it is `packages/backend/libs/common/shard/shard-name.ts` (`shardName`, `unshardName`, `shardPrefix`) and `libs/infrastructure/kafka/shard-kafka.ts`.
Scripts: `scripts/infra/shard-env.sh <n>` (prints the lines), `scripts/infra/shard-prepare.sh <n>` (creates the names, 8 s the first time, 1.4 s again), `scripts/infra/shard-run.sh <n> <total>` (vitest `--shard=n/total` with that environment).
`TEST_SHARD` must be set in the shell that starts the process (the scripts do this), not in `.env.test`.

## A. Names, service by service (non-spec code)

| Service | How the shard gets its own names | Where in the code |
|---|---|---|
| Postgres | own database `marketplace_test_s<n>`, cloned from the migrated `marketplace_test_template`; `DB_NAME` (app) and `TEST_DB_NAME` (sequelize-cli `test` env, new in `configs/db.config.js`) | setting |
| Redis | database number `n` in `REDIS_URL` (keys, streams, locks, rate limits, caches are isolated by it) | setting |
| Redis pub/sub | NOT isolated by the database number (channels are global on the server). Now prefixed: `cache:invalidate` (`cache/broadcast.ts`), `rt:ctl`, `rt:c:` (`realtime/keys.ts`, covers `channelName`, `CHANNEL_PREFIX`, `CONTROL_CHANNEL`), `collab:revoke` (`catalog/infra/collab-backplane.ts`), `chat:channel:<id>` and `chat:moderation` (`chat/domain/chat.constants.ts`) | code, `shardName` |
| Scylla | keyspace `marketplace_s<n>`, `CASSANDRA_KEYSPACE`; `scripts/cql/migrate.ts` now honours it (rewrites the keyspace name in the CQL files). Only the test helper `community/testing/feed-fixtures.ts` named `marketplace.` (now reads the variable) | setting + script |
| Dynamo | prefix `test_s<n>_`, `DYNAMO_TABLE_PREFIX`; tables created per prefix by `scripts/dynamo/create-tables.ts` | setting |
| ClickHouse | database `marketplace_test_s<n>`, `CLICKHOUSE_DATABASE`. The ClickHouse Kafka-engine table in `clickhouse/072_analytics_dedupe.sql` reads topic `analytics.events` with group `clickhouse-analytics` itself, past the Kafka wrapper: `experimentation/testing/analytics.fixtures.ts` now writes the shard names into that statement | setting + fixture |
| MinIO | bucket `marketplace-media-test-s<n>`, `MEDIA_BUCKET` (used by `s3-object-storage.ts`, `s3-page-archive.ts`, `media-app.ts`, `video-app.ts`) | setting |
| Kafka topics and consumer groups | ONE place: `createKafka()` (`kafka/kafka-client.factory.ts`) and the spec helper `testKafka()` (`test/utils/kafka-test.ts`) wrap the kafkajs client with `shardKafka()`. Every topic and group name going out gets the prefix, every name read back loses it (messages, `listTopics`, offsets, group lists, group-join events, topic configs). So the roughly 350 topic literals (`<aggregate>.events` from `topicFor`, `*.dlq`, `<group>.redrive`, `ads.clicks`, `analytics.events`, the notification topic table, tenancy constants, ...) and every group id need no edit. The outbox rows in Postgres keep the plain topic name (the database is per shard) and the relay publishes through the wrapper | code |
| SQS | queue URL = `SQS_QUEUE_URL_PREFIX` + queue name, so the shard sets the prefix to `http://localhost:9424/000000000000/s<n>-`: every queue is `s<n>-<name>` with no code change (`sqs-task-queue.ts`, `serverless/runner/runner.ts`, `lambda-local`, `notifications/testing/queues.ts`). ElasticMQ can create queues on demand through the API with a redrive policy, so no config file per shard: `shard-prepare.sh` reads `infra/docker/elasticmq/elasticmq.conf` and creates all 60 queues (58 plus the dead-letter ones, FIFO and visibility timeouts included) under the prefix. Code that uses a queue NAME instead of a URL got `shardName`: `notifications/infra/delivery-line.producer.ts` (creates lines at start), `serverless/runner/redrive.ts` (GetQueueUrl), `serverless/testing/queues.ts` (`createTestQueue`), and `sqs/queue-metrics.service.ts` (lists only the shard's queues) | prefix + code |
| Elasticsearch | `PRODUCTS_ALIAS` (`discovery/infra/search-index-names.ts`), the first index `products_m1_init` and the synonym set `product-synonyms` (`index-bootstrap.service.ts`, `index-definition.ts` `DEFAULT_SYNONYMS_SET`), the run indices `products_m1_<run>` and the pattern `products_*` (`index-manager.adapter.ts`), the pickup index `pickup_availability_v2` (`fulfilment/infra/availability-index.ts`), and the old `elasticsearch.service.ts` (`PRODUCTS_INDEX`, `SYNONYMS_SET`). The synonym set is a cluster-wide object: without a prefix two shards overwrite each other's rules. The apps create their indices at start, nothing to pre-create. Test helper `discovery/testing/search-app.ts` (wildcard `products*` cleanups) now uses the shard names | code |
| Test child apps | `test/toolkit/child-app.ts` had `marketplace_test` and port 5400 hard-coded: now `DB_NAME` / `DB_PORT` | code |

## B. Not solved by a name (stay shared or single)

- Debezium / the CDC connector (`outbox-cdc.e2e-spec.ts`, port 8183, one replication slot and one connector name for the whole cluster): run that file in one shard only, never in parallel with itself.
- Kafka broker limits: `topic_partitions_per_shard` is 1000 on the test Redpanda (`--smp 1`); each shard adds its own topics (about 60 plus the per-test ones). Several shards at once can hit the cap: delete test topics afterwards (the helpers already do) or raise `topic_partitions_per_shard` / use `--smp 2`.
- Stack memory is shared and does not grow with shards (about 7 GB in total for the nine containers); the Elasticsearch heap and Scylla `--memory 750M` are the pressure points with many shards.
- Host ports: apps listen on port 0 in the specs, so no clash was found. The fault proxies listen on a random port and forward to `localhost:9192` (the broker) which is shared, fine.
- Postgres `CREATE DATABASE ... TEMPLATE` needs no open connection to the template; nobody connects to `marketplace_test_template`. Re-run `shard-prepare.sh` after adding a migration only if the template is dropped (`DROP DATABASE marketplace_test_template` and every `marketplace_test_s*` clone, then prepare again): an existing template is NOT migrated again.
- Redis has 16 databases: shards 1 to 15 (database 0 stays the plain stack).

## C. Spec files that need a second pass (not touched by this helper)

Redis channel names written out as `rt:c:` (use `channelName(topic)` from `@app/infrastructure/realtime/keys`):
- libs/infrastructure/realtime/topic-replay.e2e-spec.ts (line 345)
- libs/infrastructure/realtime/topic-authorization.e2e-spec.ts (23)
- libs/infrastructure/realtime/realtime-fanout.e2e-spec.ts (21)
- libs/infrastructure/realtime/realtime-publisher.e2e-spec.ts (294)
- libs/infrastructure/realtime/topic-stream.e2e-spec.ts (167)

Elasticsearch index or alias written out (use `PRODUCTS_ALIAS` from `discovery/infra/search-index-names`, `shardName('products_m0_legacy')`, `AVAILABILITY_INDEX`). DANGER: the literal `products` / `products_*` in a shard run reads or deletes the DEFAULT stack's data, not the shard's:
- libs/domains/discovery/search-synonyms.e2e-spec.ts (51, 66)
- libs/domains/discovery/search-reindex.e2e-spec.ts (75, 107, 637, 642, 661, 662, 663, 671, 689, 736)
- libs/domains/discovery/search-admin.e2e-spec.ts (128, the alias in the expected answer)
- libs/domains/discovery/search-projection.e2e-spec.ts (79, 192, 197, 812, 846, 850, 860, 885)
- apps/projector/src/pickup-wiring.e2e-spec.ts (62, `pickup_availability_v2`)

SQS queues created by name in the spec (`QueueName: x` is not prefixed, but the code reads `s<n>-x`): wrap with `shardName(...)` (also in the RedrivePolicy ARN):
- libs/infrastructure/sqs/task-queue.e2e-spec.ts (63, 76)
- libs/infrastructure/outbox/outbox-tasks.e2e-spec.ts (97)
- libs/infrastructure/projections/observability.e2e-spec.ts (188, and the queue-metrics labels it expects)

Other fixed names:
- libs/domains/tenancy/shop-cells.e2e-spec.ts: second database `marketplace_test_cell_dedicated1` (add the shard, `...dedicated1_s<n>`, and drop it per shard).
- libs/infrastructure/projections/versioned-sinks.e2e-spec.ts: applies `cql/000_keyspace.cql` literally (creates the keyspace `marketplace`) and says the app uses it: use `CASSANDRA_KEYSPACE`.
- apps/lambdas/src/handlers/media-processing.e2e-spec.ts: bucket `marketplace-media-test` written out (use `process.env.MEDIA_BUCKET`).
- libs/domains/media/video-delivery.e2e-spec.ts (298): regex `marketplace-media-test` stays valid (the shard bucket starts the same); no change needed.
- libs/infrastructure/outbox/outbox-cdc.e2e-spec.ts: one shard only (see B).
- libs/domains/assistant/knowledge-ingest.e2e-spec.ts, outbox-tasks, task-queue, observability, serverless runner specs: build queue URLs from `SQS_QUEUE_URL_PREFIX`, so they follow the shard prefix without edit (checked: serverless `dead-letter.e2e-spec.ts` passes under shard 1).

Checked and fine without edit (read from the environment or random): `workers-wiring.e2e-spec.ts` (`DYNAMO_TABLE_PREFIX`, `DB_NAME`), `outbox-append.e2e-spec.ts` (`DB_NAME`), every temporary directory (mkdtemp), Kafka topics and groups named in any spec through `testKafka()`, `createKafka()` or the Nest modules.

## D. Checks done on the live test stack (shard 1 names only)

`shard-prepare.sh 1` twice (idempotent); unit tests of the touched folders (216 suites, 4089 tests) and `tsc` pass; under `shard-run.sh 1 1`: `event-publisher.e2e-spec.ts` (Kafka through the fault proxy), `search-query.e2e-spec.ts` (Elasticsearch: `s1-products` alias, `s1-products_m1_init`), `serverless/runner/dead-letter.e2e-spec.ts` (queues and redrive), `pickup-stock.e2e-spec.ts` all passed. One shard's Node process peaked at about 1.07 GB.
