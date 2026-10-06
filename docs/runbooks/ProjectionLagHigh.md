# ProjectionLagHigh

**Severity:** ticket (page via `read-model-freshness` / `payments-end-to-end` SLO burn) · **Owner:** owner of the projector · **Dashboards:** *Async* → Projection freshness

## What it means
A read model (search index, feeds, notifications, balances, ClickHouse) is > 30 s behind its events at p95. Users see stale data: a product missing from search, a paid order still "pending".

## Triage
1. Which projector? Panel "Projection freshness p95 by projector".
2. Is the consumer group lagging (→ `KafkaConsumerLagHigh`) or are events arriving late (outbox relay slow)? Outbox backlog: `SELECT count(*) FROM "Outbox" WHERE "publishedAt" IS NULL;`
3. Sink health (ES cluster status, ClickHouse inserts).

## Mitigate
- **Outbox backlog:** check the relay (core, `OutboxPublisher`) is running and Kafka is reachable.
- **Slow sink:** scale it or fix the slow query; the runner backs off instead of dropping.
- **Read-your-writes complaints:** endpoints using `ProjectionCheckpoints.waitFor` keep working; others show stale data until it catches up.
- **Projection corrupted** (wrong data, not just late): rebuild into a shadow target with `pnpm projections:rebuild` (F-05) and swap.

## Verify
p95 < 5 s for 30 min.
