#!/usr/bin/env bash

set -euo pipefail

KAFKA_CONTAINER="${KAFKA_CONTAINER:-payment_system_kafka}"
# More partitions = more parallel consumers (NestJS processes one message per
# partition at a time). Only applies to topics that don't exist yet.
KAFKA_PARTITIONS="${KAFKA_PARTITIONS:-1}"
TOPICS=(
  # J01 G-27: one topic per aggregate type of the buy-to-payout chain (keyed by aggregateId by the relay)
  "orders.events"
  "payments.events"
  "ledger.events"
  "payouts.events"
  "statements.events"
  "products.events"
  # J03 G-30: launch day (seat booking, live stream, auctions), keyed by aggregate id; the event tap reads them
  "launch_events.events"
  "live.events"
  "auctions.events"
  # J04 G-19: catalog sync to search. `catalogsync.events` is the registered name of the spec's `catalog-sync.events`.
  "pickup.events"
  "tenancy.events"
  "catalogsync.events"
  # S36 sponsored listings (L-002, L-011: every topic the code names must exist)
  "marketing.events"
  "ads.clicks"
  "ads.click-aggregates"
  "ads.clicks.dlq"
  # S38 feature flags: one `experimentation.flag_changed` per applied change (outbox relay publishes it here)
  "flags.events"
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
