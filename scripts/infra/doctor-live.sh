#!/usr/bin/env bash
# The dynamic half of the infrastructure doctor: asks the RUNNING stack whether it is healthy in the ways that failed silently on 2026-10-12.
#   scripts/infra/doctor-live.sh [--quiet]       exit 0 = healthy; exit 1 prints one line per problem
# Checks: /health/ready has no check that is down; no outbox row is parked; no outbox row has waited more than 60 s; every queue an unpublished task
# waits for exists; no dead-letter queue (*-dlq) holds messages; the search index answers. Needs docker (the dev stack's containers) and the API.
API="${API_URL:-http://localhost:8000}"; MQ="${ELASTICMQ_URL:-http://localhost:9324}"; bad=0
problem() { echo "PROBLEM: $*" >&2; bad=1; }
ready="$(curl -s "$API/health/ready")"
[[ -n "$ready" ]] || problem "the API does not answer on $API/health/ready"
down="$(echo "$ready" | jq -r '[.checks // {} | to_entries[] | select(.value != "up") | .key] | join(", ")' 2>/dev/null)"
[[ -z "$down" ]] || problem "readiness checks that are down: $down"
[[ "$(echo "$ready" | jq -r '.ready' 2>/dev/null)" == true ]] || problem "/health/ready says not ready"
pg="$(docker ps --format '{{.Names}}' | grep -m1 payment_system_db)"
if [[ -n "$pg" ]]; then
  q() { docker exec -i "$pg" psql -U postgres -d marketplace -At -c "$1" 2>&1; }
  n="$(q "select count(*) from \"Outbox\" where status='parked'")"
  [[ "$n" == 0 ]] || problem "$n outbox row(s) parked: $(q "select topic||' ('||coalesce(\"parkedReason\",'')||')' from \"Outbox\" where status='parked' limit 3" | tr '\n' ' ')"
  n="$(q "select count(*) from \"Outbox\" where status='pending' and \"createdAt\" < now() - interval '60 seconds'")"
  [[ "$n" == 0 ]] || problem "$n outbox row(s) pending for more than 60 s: $(q "select distinct topic from \"Outbox\" where status='pending' and \"createdAt\" < now() - interval '60 seconds' limit 3" | tr '\n' ' ')"
  have="$(curl -s "$MQ/?Action=ListQueues" | grep -o '<QueueUrl>[^<]*' | sed 's#.*/##')"
  for t in $(q "select distinct topic from \"Outbox\" where kind='task' and status <> 'published'"); do
    grep -qx "$t" <<<"$have" || problem "unpublished tasks wait for queue '$t', which the queue server does not have (infra/docker/elasticmq/elasticmq.conf)"
  done
else problem "no database container (payment_system_db) is running"; fi
for url in $(curl -s "$MQ/?Action=ListQueues" | grep -o '<QueueUrl>[^<]*' | sed 's/<QueueUrl>//' | grep -- '-dlq'); do
  c="$(curl -s "$url?Action=GetQueueAttributes&AttributeName=ApproximateNumberOfMessages" | grep -o '<Value>[0-9]*' | head -1 | sed 's/<Value>//')"
  [[ "${c:-0}" == 0 ]] || problem "dead-letter queue ${url##*/} holds $c message(s)"
done
curl -sf "${ES_URL:-http://localhost:9200}/_cluster/health" >/dev/null || problem "Elasticsearch does not answer"
[[ $bad == 0 && "${1:-}" != --quiet ]] && echo "doctor-live: the stack is healthy"
exit $bad
