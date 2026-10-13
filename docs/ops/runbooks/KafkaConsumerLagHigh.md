# KafkaConsumerLagHigh

**Severity:** page · **Owner:** owner of the consumer group · **Dashboards:** *Async — Kafka lag, projections, queues, jobs*

## What it means
A consumer group is > 10k messages behind for 10 min. Read models, notifications, search index or payments results are stale. Payment groups are SEV1.

## Triage (≤ 5 min)
1. Which group/topic? Panel "Kafka consumer lag by group".
2. Is it consuming at all? Lag growing linearly = stopped (crash loop, poison message); lag growing but < produce rate = too slow.
3. Logs: `{service="projector"} | json | level="error"`. Look for repeated errors on the same offset (poison) or `SinkBackpressureError` (sink slow: ES/ClickHouse).
4. Producer spike? (flash sale, bulk import)

## Mitigate
- **Poison message:** the runner retries with jitter then routes to `<group>.dlq` (F-05). If it's stuck before that, fix and redeploy, or skip the offset deliberately (`rpk group seek <group> --to <offset+1> --topics <t>`) and replay the DLQ later.
- **Too slow:** scale the projector ASG (scales on lag; check max size); partitions cap parallelism - more partitions only for new topics.
- **Sink slow** (ES/ClickHouse): fix the sink; backpressure pauses partitions instead of losing data, so lag drains on recovery.

## Verify
Lag decreasing for 15 min and below 1k; `projection_lag_seconds` p95 < 30 s.
