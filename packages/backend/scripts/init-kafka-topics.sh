#!/usr/bin/env bash

set -euo pipefail

KAFKA_CONTAINER="${KAFKA_CONTAINER:-payment_system_kafka}"
# More partitions = more parallel consumers (NestJS processes one message per
# partition at a time). Only applies to topics that don't exist yet.
KAFKA_PARTITIONS="${KAFKA_PARTITIONS:-1}"
TOPICS=(
  "payments.requests"
  "payments.responses"
  "payments.dlq"
  "products.events"
)

if ! docker inspect "${KAFKA_CONTAINER}" >/dev/null 2>&1; then
  echo "Kafka container '${KAFKA_CONTAINER}' was not found."
  echo "Start Docker first: yarn docker"
  exit 1
fi

if [[ "$(docker inspect -f '{{.State.Running}}' "${KAFKA_CONTAINER}")" != "true" ]]; then
  echo "Kafka container '${KAFKA_CONTAINER}' is not running."
  echo "Start Docker first: yarn docker"
  exit 1
fi

echo "Initializing Kafka topics in '${KAFKA_CONTAINER}'..."
for topic in "${TOPICS[@]}"; do
  docker exec "${KAFKA_CONTAINER}" rpk topic create "${topic}" -p "${KAFKA_PARTITIONS}" -r 1 >/dev/null 2>&1 || true
  docker exec "${KAFKA_CONTAINER}" rpk topic describe "${topic}" >/dev/null
  echo "  - ready: ${topic}"
done

echo "Kafka topic initialization complete."
