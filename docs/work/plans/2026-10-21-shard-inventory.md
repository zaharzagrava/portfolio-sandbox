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
