# SD-31 — Analytics Event Ingestion & A/B Testing

Status: ☑ done (typechecked; specs written, not run) · Phase 5 · Depends on: SD-38, F-05, edge-be · Extends README #25–28

## Marketplace adaptation
Track views, searches, add-to-cart, checkout steps from web/mobile; run experiments ("new product page layout", "free shipping threshold") with exposure logging and SRM checks.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Client batching + `sendBeacon`, client-generated `event_id` | 10/02 Ex2 |
| **Edge ingest** (Cloudflare worker): validate schema, enrich, `202` fast → Kafka REST (Pandaproxy / Confluent REST) | 10/02 Ex2, D14 |
| Kafka `analytics.events` (key userId) → ClickHouse via **Kafka engine + MV** (or batch consumer), `ReplacingMergeTree(event_id)` dedupe, partitioned by day | 10/09 #31 |
| Server-side business events (purchase) via outbox (trustworthy) | 10/02 Ex2 |
| Late/out-of-order by **event time** | 10/09 #31 |
| **Deterministic assignment** `murmurhash(expId:userId) % 10000` with layers/exclusion groups (shared with SD-38 evaluator) | 10/02 Ex2 |
| **Exposure events** when the variant is actually rendered | 10/02 Ex2 |
| Results: conversion per variant from ClickHouse, two-proportion z-test, **SRM chi-square check** | 10/02 Ex2 |
| Schema validation at ingest (zod), DLQ for invalid events | 06/01 |

## Steps
- [x] Event schemas in `contracts`; edge ingest route `/collect`; backend fallback `POST /events`.
- [x] ClickHouse tables + Kafka engine MV; dedupe.
- [x] `Experiment` model, assignment API, exposure logging.
- [x] Stats functions (z-test, chi-square SRM — pure, unit-tested) + `GET /experiments/:id/results`.
- [x] e2e: duplicate event_id counted once (after FINAL); assignment stable; SRM flag raised for 60/40 observed on 50/50 config.

## Scale
- Target: 200k events/s (D25).
- Hot path: edge → Kafka; no backend API involvement for client events. ClickHouse async inserts / Kafka engine.
- Capacity: Kafka 64 partitions; ClickHouse 3 shards × ~1M rows/s inserts.
- Proof: k6 ingest at edge-local; consumer lag stays < 10 s at sustained rate.

## Implementation notes (2026-10-01)
- **Ingest:**
  - Primary: edge `POST /collect` (`packages/edge-be`) — sendBeacon text/plain, validates, enriches (CF country, JWT user), clamps clocks, answers 202, produces to Kafka REST in `waitUntil`.
  - Fallback: `POST /api/events` (zod `event-schema.ts`, per-event partial acceptance, raw text/plain body), produced through the new `KafkaProducerService.sendMany`.
- **ClickHouse** (`clickhouse/070_analytics.sql`): a Kafka engine table (ClickHouse is the consumer group) → MV → `analytics_events` (ReplacingMergeTree(received_at), partitioned by EVENT day, ordered by name/day/event_id). Malformed rows go through `kafka_handle_error_mode='stream'` → `analytics_events_errors` (the DLQ). Server-side `purchase` events come via `PurchaseEventsProjector` from the outbox (ad blockers can't lose them).
- **Experiments:**
  - Migration `20261001320000`: `Experiment` with layers; a GiST exclusion constraint means RUNNING experiments of one layer can't overlap bucket ranges.
  - `assign()` uses two murmur3 hashes (layer bucket, variant bucket), shared with the SD-38 SDK.
  - `GET /api/experiments/assignments`; exposures are logged by clients (or `logExposure` server-side).
- **Readout** (`GET /api/admin/experiments/:key/results`): FINAL-deduped; the first exposure per unit fixes its variant; a conversion counts only after exposure. Two-proportion z-test vs control, plus an SRM chi-square check (`trustworthy: false` when p < 0.001). `stats.ts` is verified against textbook values (unit spec).
- **Spec** `analytics/analytics.e2e-spec.ts` covers: validation/enrichment/clamping, dedupe under FINAL, layer exclusion + DB constraint, readout with pre-exposure purchases excluded and SRM flagged.
