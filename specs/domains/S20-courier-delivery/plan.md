# Implementation Plan: S20 — Same-day courier dispatch (domain `fulfilment`, delivery part)

**Branch**: `S20-courier-delivery` (working branch `sdd/auto`) | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-58, FR-001–FR-051, SC-001–SC-010), `test-plan.md`, `gaps.md` (A1–A34, D-6/D-7/D-8/D-12, section C), `questions.md` (defaults accepted as written, no human edit), constitution v3.1.0, and the follow-ups from built siblings (below).

## Summary

Rebuild the delivery slice of `fulfilment` as five runtime paths sharing pure rules and ports in `domain/`:

1. **Courier ingest (`apps/core`, `DeliveryModule`)**: profile/shift endpoints (atomic conditional status switch in Postgres) and the location batch (validate → one Lua script updates live position + searchable membership → produce `courier.locations_reported` keyed by city). No Postgres write on the hot path (FR-009). Off-shift positions discarded; produce failure → `503 location_history_unavailable`.
2. **Dispatch (`apps/core` first attempt, `apps/worker` timers/jobs)**: pure `eligibility` + `rankCandidates` (replaceable) + radius widening. The store of record is Postgres: `DeliveryOffer` rows with partial unique indexes (one live offer per courier; one active assignment per courier) and conditional `UPDATE`s. Redis geo/lock keys are a guard and index only. Every transition = one `TransactionRunner.run`: conditional update (1 row) + `DeliveryEvent` row + `version+1` + outbox `delivery.status_changed` for milestones. `nextActionAt` is stored on the delivery; SQS `delivery-offer-timeouts` is an accelerator; job `fulfilment.recover-deliveries` (15 s) is the safety net.
3. **Request/read API (`apps/core`)**: shop create (`@Idempotent`; order must be a paid, non-cancelled deliverable-order copy that contains the shop; route ≤ 30 km; city served; ≤ 200 open per shop under a per-shop advisory lock; fee = integer `round_half_up(499 × surge)`), cancel, list/detail with keyset; role-based views with the principal in the predicate (`404` for strangers); buyer-by-order read.
4. **Order integration (`apps/worker`)**: S53 consumers for `order.paid` / `order.cancelled` / `tenancy.shop_deleted` maintaining `DeliverableOrder` (order-version guard) and cancelling open deliveries; job `fulfilment.apply-order-lifecycle` writes back through `OrderFulfilmentService.apply` after commit (single-shop only; already-reached = success).
5. **Tracking, surge, ownership**: `delivery:` topic policy through a port (replayed status without courier identity; throttled position only while `ASSIGNED`/`PICKED_UP`); surge job per owned city on eligible supply with injected clock; consistent-hash ring (128 vnodes, heartbeat 10 s / expiry 30 s, ≤ 3 hand-backs) deciding city ownership as an optimisation only. History projector (`DeliveryProjectorModule`, S53 framework) validates, dedupes `(courier, ts)`, DLQs poison.

All I/O crosses `domain/` ports with `infra/` adapters (D-6); `api/` and `application/` import no `infra/`. Foreign keys to `User`/`Shop` are dropped (D-12); orders only via R1 (`OrderFulfilmentService`) and R3 (events). The barrel exports modules + DTO/event types only (D-8). No new deployable app (I.6).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS; zod schemas in `packages/contracts/src/fulfilment/delivery.ts` (new, next to `pickup.ts`)
**Primary Dependencies**: `TransactionRunner`/`@Transactional` (S54), `OutboxService.append` + `defineEvent` (S53), S53 consumer/`Projector` framework + `DeadLetterWriter`, S54 `@Idempotent`, `definePolicies` + `RateLimitModule.forFeature` (S50), S49 `JobsService` / `declareJobType` / `upsertSchedule`, S51 `TopicRegistry.define` + `RealtimePublisher`, `ShopScoped` (S03), `Firewall()` / `@User()` (S01), `OrderFulfilmentService` (S10), `MetricsRegistry`, `CLOCK`, Dynamo service (`CourierTrack`), Redis (GEO, hash-tagged keys, Lua), `fast-check`
**Storage**: PostgreSQL (`Courier`, `Delivery`, `DeliveryEvent`, new `DeliveryOffer`, `DeliverableOrder`; idempotency rows in the S54 table); Redis (live position, searchable set, offer guard, surge map, ring heartbeats); DynamoDB `CourierTrack` (90-day expiry); SQS `delivery-offer-timeouts`; Kafka topics `delivery.events` (outbox), `courier` (direct, key = city)
**Testing**: jest e2e via `scripts/sdd/test-spec.sh` (files in `test-plan.md`), unit specs beside `domain/`; no UI journey (no web capability owns the flow)
**Target Platform**: Linux; `apps/core` (HTTP), `apps/worker` (queue, jobs, order/shop consumers), `apps/projector` (history), SSE gateway
**Project Type**: backend domain module
**Performance Goals**: location ack p99 < 20 ms (SC-001), first offer p99 < 200 ms (SC-003); load figures are ops artifacts (no load rig in the repo)
**Constraints**: no network call inside a DB transaction (FR-051); explicit timeouts on Redis/SQS/Kafka/Dynamo/order-service calls; body limit 32 KB; one retry layer per path
**Scale/Scope**: batch ≤ 20 points; 20 candidates; 8 attempts; ≤ 200 open deliveries per shop; 128 vnodes

**Maximum accepted staleness (IX.7 R3)**: deliverable-order copy 30 s (spec Assumptions); a request in that window may answer `404 order_not_found`.

**Connection arithmetic (III.12)**: pools unchanged. The location endpoint uses no connection. Dispatch transactions are short (conditional update + 2 inserts + outbox). The recovery job takes ≤ 100 overdue rows per tick with `FOR UPDATE SKIP LOCKED`, one transaction each. No pool change.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| I Boundaries | PASS after work | ports `CourierRepository`, `DeliveryRepository`, `OfferRepository`, `DeliverableOrderStore`, `GeoIndex`, `OfferGuard`, `SurgeStore`, `DispatchTimers`, `OrderLifecyclePort`, `TrackStore`, `RingRegistry` in `domain/` with tokens; adapters in `infra/`; no `forwardRef`; `domain/` takes `now`/ids as parameters (A24 `Date.now()` removed) |
| II Controllers | PASS after work | one service call per method; zod parse pipe; no Redis in controllers (A19); problem+json via the platform `DomainError` with stable codes (A14) |
| III Data access / tx | PASS after work | principal/shop in predicates; invariants by partial unique indexes and conditional writes; keyset pagination; money BIGINT; no I/O inside transactions (timer enqueue, pushes, order write-back run after commit; recovery covers loss); transitions via `TransactionRunner.run`; `.tx.baseline` = 1 is `dispatch.service.ts:340`, migrated and its `// S54 T037 audit` comment deleted (cross-spec rule 4), none added |
| IV Messaging | PASS after work | outbox for `delivery.status_changed`; consumers zod-validated, version-guarded, poison → DLQ with reason; `courier.locations_reported` v1 envelope; SQS options validated where the message is created (L-001: standard queue, no `groupId`) |
| V Contracts | PASS after work | explicit view DTOs per role; request/response schemas in `packages/contracts`; `Idempotency-Key` on the delivery request; unknown fields refused |
| VI Web | N/A | no web capability for this flow |
| VII Tests | PASS after work | AS-01–AS-58 mapped in `test-plan.md`; HTTP e2e, frozen clock, no `ShopModel` import; forced fallbacks tested; concurrency via `Promise.all`; scenarios of the old `delivery.e2e-spec.ts` preserved (L-017) |
| VIII Operational | PASS after work | metrics with per-city, fixed-enum labels; no coordinates in logs; graceful shutdown; recovery job as durability |
| IX DB isolation | PASS after work | FKs dropped by contract migration; new tables registered in `db/ownership.ts` in the same PR; `check:table-ownership --strict` zero delivery findings |
| X Monorepo | PASS after work | `DeliveryProjectorModule` for `apps/projector`; barrel per D-8; apps import modules only |

Post-design re-check: PASS. Risks: (a) the real `order.paid` / `tenancy.shop_deleted` payload field names must be read from the producers' code at task time (`userId`, `shopOrders[].shopId`; `shopVersion` may be present); (b) the `delivery-offer-timeouts` queue already appears in `elasticmq.conf` and `infra/stack/main.tf` — verify, do not duplicate (L-002/L-020); (c) the partial unique index "one active assignment per courier" must be preceded by a check for existing violators; (d) wiring: the worker, projector and core must each boot on their own with the new modules (L-018, L-015) — verified at the final checkpoint, not as a task here.

## Follow-ups from built sibling specs (treated as requirements)

1. **S10 → S20**: write back only through `OrderFulfilmentService.apply(orderId, {type: 'startFulfilment' | 'ship' | 'deliver'})`; read `order.paid` with `lines`/`shopOrders` (single-shop = exactly one `shopOrders` entry); catch `InvalidOrderTransitionError` (success if the current status is at/past the target, otherwise dead-letter with reason) and `OrderNotFoundError`.
2. **S18 / S38 → S20**: nothing targeted on plan here; no entitlement or flag call. Recorded so the list is closed.
3. **S19 → S20**: the single `// S54 T037 audit` site in `dispatch.service.ts` is ours: migrate to `TransactionRunner.run`, delete the comment.
4. **S22 / S28 → S20**: ship `delivery.status_changed` and `courier.locations_reported` schemas in `packages/contracts` with exactly the spec payloads; `gaps.md` records that S28 switches its import.
5. **S49 → S20**: `declareJobType` with payload contracts for `fulfilment.compute-surge`, `fulfilment.recover-deliveries`, `fulfilment.apply-order-lifecycle` next to the `JobPayloads` augmentation; catch `InvalidScheduleError`; handle `JobsService.cancel`'s discriminated result.
6. **S51 → S20**: register `delivery:` through `TopicRegistry.define` (one rule, data access via port).
7. **gaps.md**: every row A1–A34, D-6, D-7, D-8, D-12 and the section C lines are in the tasks below.

## Project Structure

### Documentation

```text
specs/domains/S20-courier-delivery/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/delivery-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/contracts/src/fulfilment/delivery.ts        # request/response/event schemas (A27, FR-049)
packages/backend/migrations/
  2026101x…-delivery-s20-expand.js                   # lock_timeout; feeMinor/currency/nextActionAt/cancelReason; DeliveryOffer; DeliverableOrder; partial unique indexes; backfill feeMinor
  2026101x…-delivery-s20-contract.js                 # drop 3 FKs + feeCents (separate step)
packages/backend/db/ownership.ts                     # + DeliveryOffer, DeliverableOrder (domain:fulfilment)
fulfilment/
├── domain/   delivery-state.ts(+spec) courier-eligibility.ts candidate-ranking.ts location-window.ts surge-fee.ts
│             dispatcher-ring.ts delivery-views.ts delivery-errors.ts delivery-ports.ts geohash.ts(exists)
├── application/ courier.service.ts location-ingest.service.ts dispatch.service.ts delivery-request.service.ts
│             delivery-actions.service.ts delivery-read.service.ts order-lifecycle.service.ts recovery.service.ts
│             surge.service.ts events/delivery-events.ts events/courier-events.ts
├── infra/    courier|delivery|offer|deliverable-order .repository.ts, geo-index.ts, offer-guard.ts, surge-store.ts,
│             dispatch-timers.ts (SQS), order-lifecycle.adapter.ts, track-store.ts (Dynamo), ring-registry.ts,
│             delivery-queue.worker.ts, delivery-jobs.ts, delivery-order.consumers.ts, courier-track.projector.ts, delivery-metrics.ts
├── api/      courier.controller.ts delivery.controller.ts shop-delivery.controller.ts delivery.dto.ts realtime-topics.ts
├── delivery.module.ts delivery-worker.module.ts delivery-projector.module.ts realtime-topics.module.ts
├── rate-limit-policies.ts   # + fulfilment.courier-locations / delivery-request / delivery-actions
├── index.ts                 # D-8
└── {courier-shift, courier-locations, courier-track-projector, delivery-dispatch, delivery-lifecycle, delivery-request,
     delivery-tracking, delivery-surge, delivery-city-ownership, delivery-order-events, delivery-observability}.e2e-spec.ts
apps/projector/src/projector.module.ts, apps/worker/src/worker.module.ts   # import modules only
docs/spec/capabilities/S20-courier-delivery.md       # living-spec page, written first
docs/showcase/sections/SD-23-same-day-courier-delivery.md   # A34
```

**Structure Decision**: stay inside `fulfilment`; delivery files are disjoint from S19's pickup files (not touched). `delivery.e2e-spec.ts` is replaced by the eleven e2e files; every scenario it proved (offer to nearest, accept, decline moves on, lifecycle) reappears as AS-14/15/23/29 (L-017).

## Technical tasks by gap (input for `/speckit-tasks`)

0. **Living spec first** (rule 0): no `docs/spec/capabilities/S20-*.md` page exists; create it with rules and `[proof: S20 AS-nn]` / `[code: …]` anchors; run `python3 scripts/livespec/check.py`; never create `*.reviewed.json`. Run `check:table-ownership` to confirm the section C lines.
1. **Failing e2e first** (VII.9): A1 (buyer spoof), A3 (IDOR/403), A7 (double assignment with guard keys deleted), A6 (declined after flush), A13.
2. **Contracts, policies, errors, metrics** (A14, A27): zod schemas; three rate policies; `DomainError` classes with the FR-048 codes; job types declared.
3. **Pure domain, table-driven** (A5, A12, A24, A25, A28): state machine with actor kind and `assertNever`, eligibility, ranking + cap 20 across radii, location window, fee math (`fast-check`), ring, views.
4. **Schema** (A5, A29, A30): expand migration, ownership registry; contract migration after code no longer relies on cascade (section C FK lines).
5. **Courier path** (A18–A22): atomic switch, `courier_busy`, off-shift offer withdrawal (FR-003), `GET /couriers/me`, location validation / dropped counts / 503, Lua kept, city from profile, no Postgres read on the hot path (A19), event v1 keyed by city (A22).
6. **Dispatch core** (A6–A11, A13, A15, A16): offer records + indexes, accept transaction (A8), conditional decline, empty search consumes attempt + sets `nextActionAt` atomically (A10), timers + recovery (A9), freshness (A11), idempotent repeats, cancel (shop / order / shop-deleted), outbox, history actor kind; migrate the `T037` site.
7. **Request/read API** (A1–A4): order-copy checks, idempotency, limits, advisory lock, role views, shop list/detail/cancel, buyer-by-order.
8. **Order integration** (A17): deliverable-order consumers, shop_deleted consumer, write-back job.
9. **Realtime** (A23): policy via port, status replay, position gating/throttle, `user:` pushes.
10. **Surge and ownership** (A24–A26): cities from `Courier` rows, per-city owner, ring / heartbeat / hand-back, per-city metrics, key-shape test.
11. **Wiring and barrel** (A32, A33, D-8): ports/adapters, `DeliveryProjectorModule`, app modules, barrel; confirm the queue exists in `elasticmq.conf` / `main.tf`.
12. **Docs** (A34): showcase note; patterns P0110/P0323/P0328/P1105 `spec'd` after approval; `gaps.md` "Sibling-spec follow-ups" (S10 contract wording, S28 schema import, S48 endpoint). Unverified SC-001, SC-002, SC-003, SC-004, SC-006, SC-008, SC-009 are in quickstart "Ops artifacts" and `specs/UNVERIFIED.md`.
