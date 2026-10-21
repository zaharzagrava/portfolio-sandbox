#!/usr/bin/env bash
# shard-stack.sh <n> <up|setup|down|env>: one whole TEST stack per shard, next to the others (n = 1, 2, ...; n = 0 is the plain test stack).
#   Generates docker-compose.shard<n>.yaml and packages/backend/.env.test.shard<n> from the base files by shifting every host port by 10 * n
#   and every container name by the shard number, so shards share nothing: Postgres, Redis, Kafka, Elasticsearch, ClickHouse, Scylla, Dynamo, MinIO, SQS.
#   up    start in the foreground (Ctrl+C stops it)    setup  up + migrations (migrations run with the shard's env)
#   down  stop and remove the shard's containers       env    only (re)generate the two files and print the env file path
# Run a shard's jest with:  set -a; source packages/backend/.env.test.shard<n>; set +a   (dotenv never overrides variables that are already set)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$ROOT"
n="${1:?shard number}"; mode="${2:-env}"
off=$(( n * 10 ))
compose="docker-compose.shard$n.yaml"; envf="packages/backend/.env.test.shard$n"
if (( n > 0 )); then
  # host ports only: the right-hand side of "5400:5432" stays; `localhost:9192` in the Kafka advertise address and the env values shift too
  sed -E "s/marketplace_test_/marketplace_test${n}_/g" docker-compose.test.yaml \
    | python3 -c "
import re, sys
off = $off; t = sys.stdin.read()
t = re.sub(r\"'(\d+):(\d+)'\", lambda m: \"'%d:%s'\" % (int(m.group(1)) + off, m.group(2)), t)
t = t.replace('localhost:9192', 'localhost:%d' % (9192 + off))
sys.stdout.write(t)" > "$compose"
  # env: Postgres/Redis/Kafka/ES/ClickHouse/S3/SQS/Dynamo/Scylla ports shift; names stay (each shard has its own stores)
  python3 - "$off" packages/backend/.env.test "$envf" <<'P'
import re, sys
off = int(sys.argv[1]); src = open(sys.argv[2]).read()
def bump(m): return m.group(1) + str(int(m.group(2)) + off)
out = []
for line in src.splitlines():
    k = line.split('=', 1)[0]
    if k in ('DB_PORT', 'KAFKA_BROKER', 'REDIS_URL', 'ELASTICSEARCH_NODE', 'CLICKHOUSE_URL', 'S3_ENDPOINT', 'SQS_ENDPOINT', 'SQS_QUEUE_URL_PREFIX', 'DYNAMO_ENDPOINT', 'CASSANDRA_CONTACT_POINTS'):
        line = re.sub(r'([:=])(\d{4})(?!\d)', bump, line, count=1)
    out.append(line)
open(sys.argv[3], 'w').write('\n'.join(out) + '\n')
P
else
  compose="docker-compose.test.yaml"; envf="packages/backend/.env.test"
fi
echo "shard $n: $compose, $envf"
COMPOSE=(docker compose -f "$compose" -p "marketplace_test$n")
case "$mode" in
  env) ;;
  up) "${COMPOSE[@]}" up ;;
  down) "${COMPOSE[@]}" down --remove-orphans ;;
  setup)
    "${COMPOSE[@]}" up & stack=$!
    trap 'kill -INT "$stack" 2>/dev/null || true; wait "$stack" 2>/dev/null || true; exit 130' INT TERM
    for i in $(seq 1 60); do
      kill -0 "$stack" 2>/dev/null || { echo "→ the stack exited before the migrations ran" >&2; exit 1; }
      sleep 5
      if (set -a; source "$envf"; set +a; export TEST_DB_PORT="$DB_PORT"; DOTENV_CONFIG_PATH="$ROOT/$envf" pnpm --filter api run test:stack:migrate); then
        echo "→ shard $n is up and migrated. Ctrl+C stops it."; wait "$stack"; exit $?
      fi
      echo "→ stores not ready yet (attempt $i/60)"
    done; kill -INT "$stack" 2>/dev/null || true; exit 1 ;;
  *) echo "usage: $0 <n> <up|setup|down|env>" >&2; exit 2 ;;
esac
