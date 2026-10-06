# F-05 — CQRS Projection Framework (Outbox / Debezium CDC → Kafka → Read Models)

Status: ☑ done (typechecked; spec written, not run) · Phase 0 · Depends on: F-01, F-02 · Used by: nearly every section (D26)

## Why (business story)
Buyers browse 100× more than they buy. Product pages, seat maps, auction pages, feeds, seller dashboards must be served from read-optimised stores while Postgres only guards invariants. Instead of each feature hand-rolling a consumer, one framework makes "add a read model" a 30-line projector.

## Existing code to reuse
- `outbox/` (`OutboxService`, `OutboxPublisherService` with `SKIP LOCKED`) — README #1.
- `product/search-indexer.service.ts` (Kafka → ES) — README #7 — becomes the first projector on the framework.
- `kafka/kafka-consumer.service.ts`, `kafka-producer.service.ts`.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Transactional outbox (exists) **and** log-based CDC with **Debezium** (Postgres WAL → Kafka Connect → topics) incl. the Debezium **Outbox Event Router** SMT — both paths documented, trade-offs in ADR | 06/01 §5, 03/03 §9 |
| Event envelope: `eventId`, `aggregateType`, `aggregateId`, `version`, `occurredAt`, `schemaVersion`, `traceparent` (template-literal event names, zod schemas in `contracts`) | 06/01 §7, 04/02 §8 |
| Per-aggregate ordering via Kafka key = aggregate ID | 06/01 §6 |
| **Idempotent, version-guarded upserts** (ignore event if `version <= stored`) per sink: Redis (Lua CAS), ES (`version_type=external`), Scylla (LWT `IF version < ?` only where needed; otherwise last-write-wins by version timestamp), DynamoDB (`ConditionExpression`), ClickHouse (`ReplacingMergeTree(version)`) | 06/01 §5 inbox, 06/02 |
| Consumer backpressure: batch processing, `pause()/resume()` on sink saturation, bounded in-flight | 06/01 §8, 02/02 |
| Kafka **transactions / exactly-once** read-process-write for projections that emit derived events | 06/01 §2.2 |
| Replay / rebuild: new projection version writes to a new index/table → alias swap (zero downtime) | 10/09 #37 |
| Projection lag metric (`now − event.occurredAt`) + DLQ topic per projector + poison-message parking | 07/02, 06/01 |
| Read-your-writes helper: write API returns `version`; read API accepts `minVersion` and falls back to the write model (or 202 + retry) when the projection is behind | 06/02 §1 consistency models |

## Steps
- [x] `libs/common/src/events/` — `EventEnvelope<T>` type, `defineEvent()` helper (name + zod schema + version), registry.
- [x] `libs/common/src/projections/` — `Projector` interface (`handles`, `project(batch)`), `ProjectionRunner` (consumer group per projector, batching, pause/resume, DLQ, lag metric, graceful stop via F-01).
- [x] Sinks: `RedisSink`, `EsSink`, `ScyllaSink`, `DynamoSink`, `ClickHouseSink` with version guards.
- [x] Rebuild CLI: `scripts/projections/rebuild.ts <projector>` (reset offsets to earliest into a shadow target, then swap).
- [x] Migrate `SearchIndexerService` onto the framework (keep behaviour).
- [x] Debezium: docker-compose `debezium/connect` service + `infra/debezium/outbox-connector.json` (Outbox Event Router on `Outbox` table, `wal_level=logical` in postgres image config). ADR comparing poller vs CDC; poller remains default locally, CDC is the "scale" path.
- [x] `apps/projector/` — dedicated worker app (projections scale independently of the API; scaled on consumer lag, D15).
- [x] Shared-logic specs (real Redis/ES/Kafka): out-of-order versions keep the newest per sink; poison message lands in DLQ topic; replay is idempotent.

## Scale
- Target: 200k events/s across all projections (D25); per projector partition throughput ~5–10k events/s.
- Hot path: write tx → outbox row (same tx) → CDC/poller → Kafka (partitions = 64 for hot topics, key = aggregate ID) → projector batch (500 events / 50 ms) → bulk sink write (ES `_bulk`, Scylla unlogged batch per partition, Redis pipeline, ClickHouse async insert).
- First bottleneck & fix: outbox poller on the primary DB → Debezium reads WAL (no polling queries); sink write amplification → batching + coalescing multiple events for same aggregate inside a batch (keep last version).
- Partitioning: Kafka partition by aggregate ID; projector instances = partitions / N.
- Capacity model: 64 partitions × ~5k ev/s ≈ 320k ev/s headroom; projector instance ≈ 8 partitions → 8 instances at peak.
- Proof: k6 + producer script floods `products.events`; measure projection lag p99 < 2 s at 1/2/4 projector instances (linear).

## FE visualisation (phase 2)
Admin page: projection lag per projector, rebuild button.

## Implementation notes (2026-10-01)
- `events/`: `EventEnvelope` + zod schema, `defineEvent(name, aggregate, schemaVersion, schema)` (typed `create` / validating `match`, injects `traceparent`), `DomainEventsService.record()` → outbox (CLS tx aware), `EventsModule`. Topic per aggregate: `<aggregate>.events`.
- Outbox: migration `20261001100000-outbox-domain-events` (`topic` ENUM→TEXT, `aggregateId`, `eventName`, partial pending index). **Publisher fixed (Q14)**: lease claim via `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`, backoff exponential on `attempts`, key = `aggregateId` (legacy rows keep idempotency key). `OUTBOX_RELAY=cdc` disables the poller.
- `projections/`: `Projector` contract (+`coalesceLatest`), `parseEnvelope` (accepts legacy outbox shape → version 0), `ProjectionRunner` (eachBatch, manual resolve, retries w/ jitter, poison isolation → `<group>.dlq`, `SinkBackpressureError` → pause/resume partition, `projection_lag_seconds` histogram (renamed from projection_lag_ms in SD-33), spans, shutdown order 10), `ProjectionsModule.forProjectors([...])`, `ProjectionCheckpoints` (read-your-writes `waitFor`).
- Sinks: `RedisDocSink` (Lua upsert-if-newer), `DynamoVersionedSink` (conditional put / BatchWrite with unprocessed retry), `CassandraVersionedSink` (write timestamp = version → LWW without LWT), `ClickHouseSink` (async_insert into ReplacingMergeTree). ES: `bulkUpsertProducts` gained external_gte versioning + `refresh` option; version conflicts aren't logged as failures.
- `ProductSearchProjector` replaces `SearchIndexerService` (same consumer group `search-indexer` → offsets carry over; batch `findAll` instead of N×`findOne`; no forced refresh). Legacy indexer files deleted; `core` no longer runs it.
- `apps/projector` (+ `nest-cli.json`, `start:dev:projector`, `build:projector`), shared `database/DatabaseModule`, `kafka/kafka-client.factory.ts`.
- Debezium: compose service `debezium` (profile `cdc`), `infra/debezium/outbox-connector.json` (Outbox Event Router, key=aggregateId, route by `topic`), `infra/debezium/README.md` (poller vs CDC trade-offs). Postgres already runs `wal_level=logical` (F-02).
- `pnpm projections:rebuild <group> [topics]` (offset reset; shadow-target + alias swap documented).
- Spec: `projections/projection-runner.e2e-spec.ts` (out-of-order versions, read-your-writes, poison → DLQ).
