---
id: S39
title: Analytics ingestion and A/B testing (event schema, dedupe, assignment, exposure, SRM, results)
kind: capability
status: draft
depends_on: [S01, S10, S38, S50, S52, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, projection-and-replay, transaction-runner, cache-layers]
models: []
scope:
  - packages/backend/libs/domains/experimentation/api/events.controller.ts
  - packages/backend/libs/domains/experimentation/api/ingest-*.ts
  - packages/backend/libs/domains/experimentation/api/experiment-*.ts
  - packages/backend/libs/domains/experimentation/api/experiments-admin.controller.ts
  - packages/backend/libs/domains/experimentation/application/ingest.service.ts
  - packages/backend/libs/domains/experimentation/application/assignment.service.ts
  - packages/backend/libs/domains/experimentation/application/experiment-*.ts
  - packages/backend/libs/domains/experimentation/application/analytics-metrics.ts
  - packages/backend/libs/domains/experimentation/domain/event-schema.ts
  - packages/backend/libs/domains/experimentation/domain/experiment*.ts
  - packages/backend/libs/domains/experimentation/domain/results.ts
  - packages/backend/libs/domains/experimentation/domain/stats.ts
  - packages/backend/libs/domains/experimentation/infra/sequelize-experiment.repository.ts
  - packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts
  - packages/backend/libs/domains/experimentation/infra/kafka-event-producer.ts
  - packages/backend/libs/domains/experimentation/infra/cache-running-set.ts
  - packages/backend/libs/domains/experimentation/infra/purchase-events.projector.ts
  - packages/backend/libs/domains/experimentation/infra/models/experiment*.ts
  - packages/backend/libs/domains/experimentation/analytics*.module.ts
  - packages/contracts/src/analytics/*.ts
  - packages/contracts/src/experimentation/experiments.ts
  - packages/backend/clickhouse/072_analytics_dedupe.sql
  - packages/backend/migrations/20261014100000-experiments-lifecycle.js
---
# S39 - Analytics ingestion and A/B testing (event schema, dedupe, assignment, exposure, SRM, results)
## Purpose
Browsers, apps and the edge send batches of analytics events; the collector says precisely why it rejects an event, never trusts identity fields and never reports an unacknowledged event as accepted. Every event is counted once however often it is delivered. A platform admin drafts, starts and stops experiments that cannot be edited into a lie; a unit always gets the same variant; the readout withholds its comparison when the data is broken.

## Entry points
- `POST /api/events` (the fallback) and the collector of the edge worker (`packages/edge-be`, same rules): batches of 1 to 50 events. [code: packages/backend/libs/domains/experimentation/api/events.controller.ts#EventsController] [code: packages/contracts/src/analytics/ingest-rules.ts#validateIngestEvent]
- `GET /api/experiments/assignments`, public, the caller's variants. [code: packages/backend/libs/domains/experimentation/api/experiment-assignments.controller.ts#ExperimentAssignmentsController]
- `PUT /api/admin/experiments/:key`, `POST …/start`, `POST …/stop`, `GET /api/admin/experiments`, `GET …/:key`, `GET …/:key/history`, `GET …/:key/results`. [code: packages/backend/libs/domains/experimentation/api/experiments-admin.controller.ts#ExperimentsAdminController]
- Topic `analytics.events` (key `anonymous_id`) and the `purchase` projector `analytics-purchases`. [code: packages/backend/libs/domains/experimentation/domain/event-schema.ts#ANALYTICS_TOPIC] [code: packages/backend/libs/domains/experimentation/infra/purchase-events.projector.ts#PurchaseEventsProjector]

## Rules
- **S39.R-01** A valid batch MUST answer `202` with `{accepted, rejected: []}`, put one message per event on `analytics.events` keyed by `anonymous_id` with the stored shape (`ts` and `received_at` as `YYYY-MM-DD HH:mm:ss.SSS` UTC, every prop a string, `platform` `web`). [proof: S39 AS-01] [code: packages/backend/libs/domains/experimentation/application/ingest.service.ts#IngestService]
- **S39.R-02** `user_id` MUST come only from a verified token (a stale token leaves the event anonymous) and a body field `user_id`, `received_at`, `country` or `platform` MUST reject that event as `forbidden_field`. [proof: S39 AS-02] [code: packages/backend/libs/domains/experimentation/api/ingest-context.ts#ingestContext]
- **S39.R-03** Each invalid event MUST be reported by index with exactly one code from the closed list in the order `invalid_event_id`, `unknown_event_name`, `invalid_anonymous_id`, `invalid_timestamp`, `invalid_props`, `invalid_page`, `invalid_exposure`, `forbidden_field`, `event_too_old`, `duplicate_in_batch`, and the valid events of the batch MUST still be accepted. [proof: S39 AS-03] [code: packages/contracts/src/analytics/ingest-rules.ts#validateIngestEvent]
- **S39.R-04** A body that is not JSON, has no `events` array, has 0 or 51 events MUST be `400` `validation_failed`, a body above 128 KiB `413` `payload_too_large`, a content type other than JSON or text MUST be `415` `unsupported_media_type`, and nothing is produced. [proof: S39 AS-04] [code: packages/backend/libs/domains/experimentation/api/ingest-body.guard.ts#IngestBodyGuard]
- **S39.R-05** An event older than 7 days MUST be rejected `event_too_old`, one more than 10 minutes ahead MUST be stored with `ts` equal to the receive time, and every other `ts` kept as sent, both limits inclusive. [proof: S39 AS-05] [code: packages/contracts/src/analytics/ingest-rules.ts#clampTimestamp]
- **S39.R-06** A `text/plain` body (a beacon) MUST give the same outcome as the same JSON sent as `application/json`. [proof: S39 AS-06] [code: packages/backend/libs/domains/experimentation/api/ingest-body.pipe.ts#IngestBodyPipe]
- **S39.R-07** A repeated `event_id` inside one batch MUST be collapsed (the first wins) and the rest reported `duplicate_in_batch`. [proof: S39 AS-07] [code: packages/backend/libs/domains/experimentation/application/ingest.service.ts#IngestService]
- **S39.R-08** When the stream does not acknowledge within 2 seconds the fallback MUST answer `503` `ingest_unavailable` with `Retry-After`, report nothing accepted and count the failure; the same batch retried after recovery is accepted. [proof: S39 AS-08] [code: packages/backend/libs/domains/experimentation/infra/kafka-event-producer.ts#KafkaEventProducer]
- **S39.R-09** Ingestion MUST be limited to 120 requests a minute per user or address (`429` with `Retry-After`) and MUST fail open, counted, when the limiter's store is down. [proof: S39 AS-09] [code: packages/backend/libs/domains/experimentation/rate-limit-policies.ts#analyticsRatePolicies]
- **S39.R-10** The edge collector and the fallback MUST judge every event the same, from one rule file and one table of vectors; the edge answers `202` before acknowledgement, retries the produce 3 times with full-jitter backoff and counts events it finally fails to produce. [proof: S39 AS-10] [code: packages/contracts/src/analytics/ingest-rules.ts#validateIngestEvent]
- **S39.R-11** `country` MUST be recorded only with the edge credential and `platform` only from `web`, `ios`, `android` (default `web`, never `server`). [proof: S39 AS-11] [code: packages/backend/libs/domains/experimentation/api/ingest-context.ts#ingestContext]
- **S39.R-12** One `event_id` delivered several times, with other receive times, names or a re-clamped `ts`, MUST count once on every read, before or after any merge, and the first received copy MUST be the one read. [proof: S39 AS-12, S39 AS-44] [code: packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts#ClickHouseEventStore]
- **S39.R-13** Events MUST be analysed by event time: an exposure and a purchase convert in either arrival order only when the purchase's event time is not before the exposure. [proof: S39 AS-13] [code: packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts#ClickHouseEventStore]
- **S39.R-14** A malformed stream message MUST land in the error table with its raw payload, error, topic, partition and offset without stopping the stream. [proof: S39 AS-14] [code: packages/backend/clickhouse/072_analytics_dedupe.sql]
- **S39.R-15** Every `order.paid` MUST become one `purchase` event (`event_id` the envelope id, `ts` its `occurredAt`, `props {order_id, total, currency}`), a second delivery MUST change nothing, and a payload that fails the schema MUST be dead-lettered and counted. [proof: S39 AS-15] [code: packages/backend/libs/domains/experimentation/infra/purchase-events.projector.ts#PurchaseEventsProjector]
- **S39.R-16** Events MUST be partitioned by event day and kept 400 days, the error table 14 days, and the stream consumer group is `clickhouse-analytics`. [proof: S39 AS-16] [code: packages/backend/clickhouse/072_analytics_dedupe.sql]
- **S39.R-17** Assignment MUST be `bucketOf("layer:" + layer, unit)` for the layer and `bucketOf("exp:" + key, unit)` for the variant with exact integer weights, the same for a unit on every call, and a unit is in the experiment when `layerFrom <= layerBucket < layerTo`. [proof: S39 AS-17, S39 AS-18, S39 AS-19] [code: packages/backend/libs/domains/experimentation/domain/experiments.ts#assign]
- **S39.R-18** `GET /api/experiments/assignments` MUST assign `user` experiments from the authenticated principal only and `visitor` experiments from a valid `X-Anonymous-Id` only, and omit draft and stopped experiments. [proof: S39 AS-20, S39 AS-21] [code: packages/backend/libs/domains/experimentation/application/assignment.service.ts#AssignmentService]
- **S39.R-19** The assignments answer MUST parse with its schema, carry `Cache-Control: private, no-store` and `Vary: Authorization, X-Anonymous-Id`, and be limited to 120 a minute. [proof: S39 AS-22] [code: packages/backend/libs/domains/experimentation/api/experiment-assignments.controller.ts#ExperimentAssignmentsController]
- **S39.R-20** With the cache down the running set MUST come from the database, and with both down within 500 ms the answer MUST be `200 {assignments: {}, degraded: true}` and counted. [proof: S39 AS-23] [code: packages/backend/libs/domains/experimentation/infra/cache-running-set.ts#CacheRunningSet]
- **S39.R-21** A stopped experiment MUST stop being assigned at once by the instance that stopped it and within 15 seconds by every other. [proof: S39 AS-24] [code: packages/backend/libs/domains/experimentation/infra/cache-running-set.ts#CacheRunningSet]
- **S39.R-22** Only an `exposure` with `props {experiment, variant}` or `{flag_key, variant, flag_version}` MUST be accepted, and flag exposures MUST never appear in an experiment's results. [proof: S39 AS-26] [code: packages/contracts/src/analytics/ingest-rules.ts#validateIngestEvent]
- **S39.R-23** A unit MUST count once, at its first exposure inside `[startedAt, stoppedAt or now]`; a unit exposed to two variants is a crossover, excluded and counted, and above 1 % of exposed units the readout is untrustworthy; unknown variants are excluded and counted. [proof: S39 AS-25, S39 AS-27, S39 AS-28, S39 AS-29] [code: packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts#ClickHouseEventStore]
- **S39.R-24** Creating an experiment with `expectedVersion: 0` MUST answer `201` with `Location` and the stored experiment (`draft`, version 1) and write one `create` history row with the admin as actor. [proof: S39 AS-30] [code: packages/backend/libs/domains/experimentation/application/experiment-command.service.ts#ExperimentCommandService]
- **S39.R-25** A save equal to the stored definition MUST be a `200` no-op without a history row, a stale `expectedVersion` MUST be `409` `version_conflict`, and of two parallel saves with one version exactly one wins. [proof: S39 AS-31] [code: packages/backend/libs/domains/experimentation/domain/experiment-lifecycle.ts#decide]
- **S39.R-26** Shape errors MUST be `400` `validation_failed` and semantic errors `422` `experiment_definition_invalid` with every `{path, code}` at once. [proof: S39 AS-32] [code: packages/backend/libs/domains/experimentation/domain/experiment-definition.ts#validateDefinition]
- **S39.R-27** `start` and `stop` MUST be idempotent, one history row per applied change even under parallel calls, `start` of a stopped and `stop` of a draft experiment MUST be `409` `illegal_transition`. [proof: S39 AS-33, S39 AS-34] [code: packages/backend/libs/domains/experimentation/domain/experiment-lifecycle.ts#decide]
- **S39.R-28** Once running or stopped, a change to variants, weights, layer, range, unit or metric MUST be `409` `experiment_immutable`, while description and owner may change. [proof: S39 AS-35] [code: packages/backend/libs/domains/experimentation/domain/experiment-lifecycle.ts#decide]
- **S39.R-29** Two running experiments of one layer MUST NOT overlap in range: an overlapping start is `409` `layer_range_conflict`, two parallel starts give one winner, and a stopped experiment frees its range. [proof: S39 AS-36] [code: packages/backend/libs/domains/experimentation/infra/sequelize-experiment.repository.ts#SequelizeExperimentRepository]
- **S39.R-30** At most 200 experiments MUST exist (`422` `experiment_limit_reached` for a new key; updates still work). [proof: S39 AS-37] [code: packages/backend/libs/domains/experimentation/application/experiment-command.service.ts#ExperimentCommandService]
- **S39.R-31** The list MUST be a keyset page ordered by `createdAt` then `key` descending (`limit` 1 to 200, a status filter, a tampered cursor `400`), and an unknown key `404`. [proof: S39 AS-38] [code: packages/backend/libs/domains/experimentation/application/experiment-query.service.ts#ExperimentQueryService]
- **S39.R-32** The history MUST list one row per applied change newest first, none for a no-op, always with an actor. [proof: S39 AS-39] [code: packages/backend/libs/domains/experimentation/application/experiment-query.service.ts#ExperimentQueryService]
- **S39.R-33** Admin routes MUST answer `401` without credentials and an identical `403` to other roles whether or not the key exists. [proof: S39 AS-40] [code: packages/backend/libs/domains/experimentation/api/experiments-admin.controller.ts#ExperimentsAdminController]
- **S39.R-34** Admin writes MUST be limited to 30 a minute per admin and results reads to 20 a minute, `429` beyond. [proof: S39 AS-41, S39 AS-53] [code: packages/backend/libs/domains/experimentation/rate-limit-policies.ts#analyticsRatePolicies]
- **S39.R-35** The results MUST report per variant exposed units, converted units and rate, and against control the difference, lift (`null` for a zero control rate), pooled z and p, an unpooled 95 % interval and significance at `0.05 / (variants - 1)`, all finite. [proof: S39 AS-42, S39 AS-47, S39 AS-48] [code: packages/backend/libs/domains/experimentation/domain/stats.ts#compareToControl]
- **S39.R-36** A unit MUST convert at most once, only by an event at or after its first exposure and not after the window end; an event late to the store but inside the window MUST count. [proof: S39 AS-43, S39 AS-52] [code: packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts#ClickHouseEventStore]
- **S39.R-37** A sample ratio mismatch (`p < 0.001`) or crossover above 1 % MUST make the readout untrustworthy and withhold every comparison; an arm under 100 units gives `insufficient_sample`; no exposures give `no_data`. [proof: S39 AS-45, S39 AS-46, S39 AS-50] [code: packages/backend/libs/domains/experimentation/domain/results.ts#assembleResults]
- **S39.R-38** A `user` experiment MUST count only events with a user id (the rest reported unattributable) and a `visitor` experiment MUST key every event by its anonymous id. [proof: S39 AS-49] [code: packages/backend/libs/domains/experimentation/infra/clickhouse-event-store.ts#ClickHouseEventStore]
- **S39.R-39** When the analytical store fails or takes over 10 seconds the results MUST be `503` `analytics_store_unavailable` with `Retry-After` and no numbers. [proof: S39 AS-51] [code: packages/backend/libs/domains/experimentation/application/experiment-results.service.ts#ExperimentResultsService]
- **S39.R-40** The metrics of the pipeline MUST match what happened and logs MUST be JSON with the request id and never carry props values, user ids, tokens or more than 4 characters of an anonymous id. [proof: S39 AS-54, S39 AS-55] [code: packages/backend/libs/domains/experimentation/application/analytics-metrics.ts#analyticsEventsTotal]
- **S39.R-41** The domain MUST own its tables (`Experiment`, `ExperimentAudit`, the ClickHouse event tables) and reach only identity and the `order.paid` contract. [proof: S39 AS-56] [code: packages/backend/libs/domains/experimentation/infra/models/experiment-audit.model.ts]
- **S39.R-42** One `exposure` per rendered variant is owned by the storefront journey of W02. [proof: none] [code: packages/backend/libs/domains/experimentation/domain/event-schema.ts#ANALYTICS_TOPIC]

## Behaviors
- **S39.B-01** Given a phone that retries a batch after a timeout, then the store holds each event once. [proof: S39 AS-12]
- **S39.B-02** Given two admins editing the same draft, then one save wins and the other is told to reload. [proof: S39 AS-31]
- **S39.B-03** Given a running test whose exposure logging breaks, then the readout shows a sample ratio mismatch and no winner. [proof: S39 AS-45]
- **S39.B-04** Given the cache and the database down, then everybody sees control and the page still loads. [proof: S39 AS-23]

## Lifecycles
An experiment is `draft` (editable, deletable by nobody), `running` (only description and owner change, its layer range is exclusive) or `stopped` (final, never restarted). Every applied change raises the version by one and appends one history row; a no-op does neither.

## Owns
- PostgreSQL tables `Experiment` and `ExperimentAudit` (append-only); ClickHouse `analytics_event_log` (plain MergeTree, read with a first-copy collapse), `analytics_events` (frozen for one release), `analytics_events_queue`, `analytics_events_errors`.
- Redis key `experiments:running`; topic `analytics.events`; projector `analytics-purchases`; rate-limit policies `analytics.ingest`, `experiments.assignments`, `experiments.admin.write`, `experiments.results`.

## Decisions
- Identity is `event_id` alone and every read collapses copies with `argMin` over `(received_at, ts, name)`: a re-clamped `ts` lands in another partition where no merge can see the first copy.
- The ingest rules live in one dependency-free file in `packages/contracts` read by the backend and the edge worker; one JSON table of vectors keeps them equal.
- Retries happen at one layer: the edge retries its background produce, the fallback answers `503` and the client retries.
- Results are computed per request from one query and one snapshot; a failing store never yields partial numbers.

## Known gaps
- The capacity criteria (SC-001 ingest latency and load, SC-004 assignment speed, SC-006 results at one million units) have no automated proof (listed in `specs/UNVERIFIED.md`).
- One `exposure` per render (AS-57) belongs to the W02 journey, which does not exist yet.
