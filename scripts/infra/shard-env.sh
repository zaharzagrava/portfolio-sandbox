#!/usr/bin/env bash
# shard-env.sh <n>: prints the environment lines of test shard n on the SHARED test stack (docker-compose.test.yaml, project marketplace_test).
# Only what differs from packages/backend/.env.test is printed; everything else (ports, secrets) comes from .env.test as before.
# Use:  set -a; eval "$(scripts/infra/shard-env.sh 1)"; set +a      (variables set in the shell win over .env.test: dotenv never overrides)
# n = 1..15 (the Redis database number). Shard names:
#   TEST_SHARD             1          prefix `s1-` for Kafka topics and groups, queue names, search indices and synonym set, Redis channels (libs/common/shard)
#   DB_NAME / TEST_DB_NAME marketplace_test_s1      Postgres database, cloned from marketplace_test_template
#   REDIS_URL              redis://localhost:650<n>/0 (the shard's own Redis container, not the shared one)
#   CASSANDRA_KEYSPACE     marketplace_s1
#   DYNAMO_TABLE_PREFIX    test_s1_
#   CLICKHOUSE_DATABASE    marketplace_test_s1
#   MEDIA_BUCKET           marketplace-media-test-s1
#   SQS_QUEUE_URL_PREFIX   <endpoint>/000000000000/s1-   (queue URL = prefix + queue name, so every queue of the shard is `s1-<name>`)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
n="${1:?shard number (1..15)}"
[[ "$n" =~ ^([1-9]|1[0-5])$ ]] || { echo "shard must be 1..15" >&2; exit 2; }
ENV_FILE="${STACK_ENV_FILE:-$ROOT/packages/backend/.env.test}"
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
redis_url="$(val REDIS_URL)"; sqs_prefix="$(val SQS_QUEUE_URL_PREFIX)"
cat <<OUT
TEST_SHARD=$n
DB_NAME=marketplace_test_s$n
TEST_DB_NAME=marketplace_test_s$n
REDIS_URL=redis://localhost:$((6500 + n))/0
CASSANDRA_KEYSPACE=marketplace_s$n
DYNAMO_TABLE_PREFIX=test_s${n}_
CLICKHOUSE_DATABASE=marketplace_test_s$n
MEDIA_BUCKET=$(val MEDIA_BUCKET)-s$n
SQS_QUEUE_URL_PREFIX=${sqs_prefix}s$n-
OUT
