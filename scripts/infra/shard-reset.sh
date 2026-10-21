#!/usr/bin/env bash
# shard-reset.sh <n>: gives test shard n a clean slate again (the default stack gets one when it starts; shard names live on). Deletes:
#   Kafka topics s<n>-*, ElasticMQ queues s<n>-*, Elasticsearch indices s<n>-*, the files in the shard's MinIO bucket, everything in the shard's Redis
#   (and its ACL rules), the shard's Postgres database and ClickHouse database. scripts/infra/shard-prepare.sh <n> recreates what is needed.
# Scylla and Dynamo are not dropped: the tests wipe those themselves before each test. Never touches the default names.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
n="${1:?shard number}"; PROJECT="${STACK_PROJECT:-marketplace_test}"
ENV_FILE="${STACK_ENV_FILE:-$ROOT/packages/backend/.env.test}"
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
set -a; eval "$("$ROOT/scripts/infra/shard-env.sh" "$n")"; set +a
(
  topics=$(docker exec "${PROJECT}_kafka" rpk topic list 2>/dev/null | awk -v p="s$n-" 'NR>1 && index($1,p)==1 {print $1}' | tr '\n' ' ')
  # shellcheck disable=SC2086
  [[ -n "$topics" ]] && docker exec "${PROJECT}_kafka" rpk topic delete $topics >/dev/null 2>&1
) &
(
  ep="$(val SQS_ENDPOINT)"
  curl -s "$ep/?Action=ListQueues&QueueNamePrefix=s$n-" | grep -oE "<QueueUrl>[^<]+" | sed 's/<QueueUrl>//' | while read -r url; do curl -s "$ep/${url#*://*/}?Action=DeleteQueue" >/dev/null; done
) &
(
  es="$(val ELASTICSEARCH_NODE)"
  curl -s "$es/_cat/indices/s$n-*?h=index" | while read -r idx; do [[ -n "$idx" ]] && curl -s -X DELETE "$es/$idx" >/dev/null; done
  curl -s -X DELETE "$es/_synonyms/s$n-product-synonyms" >/dev/null 2>&1 || true
) &
( docker exec "${PROJECT}_minio" sh -c "/usr/bin/mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null 2>&1; /usr/bin/mc rm --recursive --force local/$MEDIA_BUCKET >/dev/null 2>&1" ) &
( r="${PROJECT}_redis_s$n"; docker ps --format '{{.Names}}' | grep -qx "$r" && { docker exec "$r" redis-cli ACL SETUSER default allkeys >/dev/null; docker exec "$r" redis-cli FLUSHALL >/dev/null; } ) &
( docker exec -i "${PROJECT}_db" psql -U postgres -qtA -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null 2>&1 ) &
( curl -s "$(val CLICKHOUSE_URL)/" --data-binary "DROP DATABASE IF EXISTS $CLICKHOUSE_DATABASE" >/dev/null 2>&1 ) &
wait
echo "[shard $n] reset"
