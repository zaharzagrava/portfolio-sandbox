#!/usr/bin/env bash
# shard-prepare.sh <n>: creates what test shard n needs on the SHARED test stack (compose project marketplace_test). Idempotent; safe to run again.
#   Postgres    database marketplace_test_s<n> cloned from marketplace_test_template (created and migrated once; the clone takes about a second)
#   Scylla      keyspace marketplace_s<n> (cql migrations run with CASSANDRA_KEYSPACE)
#   Dynamo      tables with the prefix test_s<n>_
#   ClickHouse  database marketplace_test_s<n> with the tables of packages/backend/clickhouse/*.sql (scripts/clickhouse/migrate.ts)
#   MinIO       bucket marketplace-media-test-s<n>
#   SQS         the queues of infra/docker/elasticmq/elasticmq.conf (dead-letter queues too) as s<n>-<name>, created through the ElasticMQ API
#   Kafka       the topics of scripts/init-kafka-topics.sh as s<n>-<topic> (the broker creates any other topic on first use)
#   Redis       its OWN container marketplace_test_redis_s<n> on port 6500+<n> (some tests change ACL rules on the default user, which is server-wide;
#               on the shared Redis that broke every other shard). Started with docker run -d --rm; stop with: docker rm -f marketplace_test_redis_s<n>
#   Elasticsearch  nothing to create: the apps create s<n>-products_m1_init, the alias s<n>-products and the pickup index when they start
# Never touches the default names (no prefix / no suffix). Env of the shard: scripts/infra/shard-env.sh <n>. Container names: STACK_PROJECT (default marketplace_test).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
n="${1:?shard number (1..15)}"
PROJECT="${STACK_PROJECT:-marketplace_test}"
ENV_FILE="${STACK_ENV_FILE:-$ROOT/packages/backend/.env.test}"
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
set -a; eval "$("$ROOT/scripts/infra/shard-env.sh" "$n")"; set +a
BACKEND="$ROOT/packages/backend"
TEMPLATE=marketplace_test_template
PG="docker exec -i ${PROJECT}_db psql -U postgres -v ON_ERROR_STOP=1 -qtA"
SQS_ENDPOINT="${SQS_ENDPOINT:-$(val SQS_ENDPOINT)}"
CH_URL="$(val CLICKHOUSE_URL)"
export DB_HOST=localhost DB_PORT="$(val DB_PORT)" DB_USERNAME=postgres DB_PASSWORD=postgres
export DYNAMO_ENDPOINT="$(val DYNAMO_ENDPOINT)" CASSANDRA_CONTACT_POINTS="$(val CASSANDRA_CONTACT_POINTS)" CASSANDRA_LOCAL_DC="$(val CASSANDRA_LOCAL_DC)"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
redis_name="${PROJECT}_redis_s$n"
if ! docker ps --format '{{.Names}}' | grep -qx "$redis_name"; then
  docker rm -f "$redis_name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$redis_name" -p "$((6500 + n)):6379" redis:alpine >/dev/null
fi
t0=$SECONDS; log() { echo "[shard $n +$((SECONDS - t0))s] $*"; }
pids=()

# --- Postgres: the template is migrated once (a lock keeps two prepares from migrating it twice); the shard database is a clone
(
  flock 9
  if [[ "$($PG -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$TEMPLATE'")" != 1 ]]; then
    log "postgres: creating and migrating $TEMPLATE (once)"
    $PG -d postgres -c "CREATE DATABASE $TEMPLATE"
    (cd "$BACKEND" && TEST_DB_NAME=$TEMPLATE TEST_DB_PORT="$DB_PORT" npx sequelize-cli db:migrate --env test >/dev/null)
  fi
  if [[ "$($PG -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" != 1 ]]; then
    $PG -d postgres -c "CREATE DATABASE $DB_NAME TEMPLATE $TEMPLATE"
    log "postgres: $DB_NAME cloned"
  else log "postgres: $DB_NAME exists"; fi
) 9>"/tmp/${PROJECT}_shard_template.lock" & pids+=($!)

# --- Scylla keyspace (slowest: DDL is serialized by the server) and Dynamo tables
( cd "$BACKEND" && DOTENV_CONFIG_PATH=/dev/null npx ts-node -r tsconfig-paths/register scripts/cql/migrate.ts >/dev/null && log "scylla: keyspace $CASSANDRA_KEYSPACE ready" ) & pids+=($!)
( cd "$BACKEND" && DOTENV_CONFIG_PATH=/dev/null npx ts-node -r tsconfig-paths/register scripts/dynamo/create-tables.ts >/dev/null && log "dynamo: tables $DYNAMO_TABLE_PREFIX* ready" ) & pids+=($!)

# --- ClickHouse database, MinIO bucket
( cd "$BACKEND" && DOTENV_CONFIG_PATH=/dev/null CLICKHOUSE_URL="$CH_URL" CLICKHOUSE_USER="$(val CLICKHOUSE_USER)" CLICKHOUSE_PASSWORD="$(val CLICKHOUSE_PASSWORD)" npx ts-node -r tsconfig-paths/register scripts/clickhouse/migrate.ts >/dev/null && log "clickhouse: $CLICKHOUSE_DATABASE ready (tables migrated)" ) & pids+=($!)
( docker exec "${PROJECT}_minio" sh -c "/usr/bin/mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null && /usr/bin/mc mb --ignore-existing local/$MEDIA_BUCKET >/dev/null" && log "minio: bucket $MEDIA_BUCKET ready" ) & pids+=($!)

# --- SQS: every queue of the stand-in config under the shard prefix, dead-letter queues first
( python3 - "$ROOT/infra/docker/elasticmq/elasticmq.conf" "$SQS_ENDPOINT" "s$n-" <<'PY'
import json, re, sys, urllib.parse, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
conf, endpoint, prefix = sys.argv[1:4]
queues = {}
inside = False
for line in open(conf):
    if re.match(r'^queues\s*\{', line): inside = True; continue
    if inside and line.startswith('}'): break
    m = re.match(r'^\s*"?([\w.-]+)"?\s*\{(.*)\}\s*$', line)
    if not (inside and m): continue
    name, body = m.groups()
    vis = re.search(r'defaultVisibilityTimeout\s*=\s*(\d+)', body)
    dlq = re.search(r'deadLettersQueue\s*\{\s*name\s*=\s*"([^"]+)"\s*,\s*maxReceiveCount\s*=\s*(\d+)', body)
    queues[name] = dict(vis=vis.group(1) if vis else None, fifo='fifo = true' in body or name.endswith('.fifo'),
                        dedup=re.search(r'contentBasedDeduplication\s*=\s*(\w+)', body), dlq=dlq.groups() if dlq else None)
def create(name):
    q = queues[name]; attrs = {}
    if q['vis']: attrs['VisibilityTimeout'] = q['vis']
    if q['fifo']:
        attrs['FifoQueue'] = 'true'; attrs['ContentBasedDeduplication'] = q['dedup'].group(1) if q['dedup'] else 'false'
    if q['dlq']:
        attrs['RedrivePolicy'] = json.dumps({'deadLetterTargetArn': f'arn:aws:sqs:elasticmq:000000000000:{prefix}{q["dlq"][0]}', 'maxReceiveCount': int(q['dlq'][1])})
    params = {'Action': 'CreateQueue', 'QueueName': prefix + name, 'Version': '2012-11-05'}
    for i, (k, v) in enumerate(attrs.items(), 1):
        params[f'Attribute.{i}.Name'] = k; params[f'Attribute.{i}.Value'] = v
    try: urllib.request.urlopen(endpoint + '/?' + urllib.parse.urlencode(params), timeout=30).read()
    except urllib.error.HTTPError as e:
        if b'QueueAlreadyExists' not in e.read(): raise
dead = [n for n in queues if re.search(r'-dlq(\.fifo)?$', n)]
with ThreadPoolExecutor(8) as ex:
    list(ex.map(create, dead)); list(ex.map(create, [n for n in queues if n not in dead]))
print(f'[shard] sqs: {len(queues)} queues as {prefix}<name>')
PY
) & pids+=($!)

# --- Kafka: the known topics under the shard prefix (one rpk call); anything else is created by the broker on first use
(
  topics=$(grep -oE '^\s*"[a-z0-9_.-]+"' "$BACKEND/scripts/init-kafka-topics.sh" | tr -d ' "' | sed "s/^/s$n-/" | tr '\n' ' ')
  # shellcheck disable=SC2086
  docker exec "${PROJECT}_kafka" rpk topic create $topics >/dev/null 2>&1 || true
  log "kafka: topics s$n-* ready"
) & pids+=($!)

fail=0; for p in "${pids[@]}"; do wait "$p" || fail=1; done
(( fail == 0 )) && log "ready: $DB_NAME, $CASSANDRA_KEYSPACE, $DYNAMO_TABLE_PREFIX*, $CLICKHOUSE_DATABASE, $MEDIA_BUCKET, s$n-* queues and topics, redis db $n" || { log "FAILED"; exit 1; }
