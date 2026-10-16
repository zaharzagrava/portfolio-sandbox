---
id: S20
title: Same-day courier dispatch (courier shift, offers, delivery state machine, tracking)
kind: capability
status: draft
depends_on: [S01, S03, S10, S49, S50, S51, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, idempotency-key, outbox-task-queue, job-scheduler-lease, transaction-runner, realtime-topic-stream, projection-and-replay, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/fulfilment/api/delivery*.ts
  - packages/backend/libs/domains/fulfilment/api/courier*.ts
  - packages/backend/libs/domains/fulfilment/api/shop-delivery*.ts
  - packages/backend/libs/domains/fulfilment/application/courier*.ts
  - packages/backend/libs/domains/fulfilment/application/delivery*.ts
  - packages/backend/libs/domains/fulfilment/application/dispatch*.ts
  - packages/backend/libs/domains/fulfilment/application/location*.ts
  - packages/backend/libs/domains/fulfilment/application/order-lifecycle*.ts
  - packages/backend/libs/domains/fulfilment/application/recovery*.ts
  - packages/backend/libs/domains/fulfilment/application/surge*.ts
  - packages/backend/libs/domains/fulfilment/domain/courier*.ts
  - packages/backend/libs/domains/fulfilment/domain/candidate*.ts
  - packages/backend/libs/domains/fulfilment/domain/delivery*.ts
  - packages/backend/libs/domains/fulfilment/domain/dispatcher*.ts
  - packages/backend/libs/domains/fulfilment/domain/location*.ts
  - packages/backend/libs/domains/fulfilment/domain/surge*.ts
  - packages/backend/libs/domains/fulfilment/domain/geohash.ts
  - packages/contracts/src/fulfilment/delivery.ts
---
# S20 - Same-day courier dispatch
## Purpose
A courier registers, goes on shift and streams positions; a shop requests a same-day delivery for a paid order; dispatch offers it to the nearest eligible courier one at a time with a 15 second timeout; the delivery moves through a strict state machine to `DELIVERED`; the buyer follows the courier live; the order learns the progress. Postgres is the store of record for deliveries, offers and the history; Redis holds only the live position index and guards; DynamoDB holds the 90 day position history.

## Entry points
- `POST /api/couriers/me`, `GET /api/couriers/me`, `PUT /api/couriers/me/availability`, `POST /api/couriers/me/locations`: courier profile, shift, self view and position batches. [code: packages/backend/libs/domains/fulfilment/api/courier.controller.ts#CourierController]
- `POST /api/deliveries/:id/accept`, `/decline`, `/picked-up`, `/delivered`, `GET /api/deliveries/:id`, `GET /api/orders/:orderId/deliveries`: courier actions and role views. [code: packages/backend/libs/domains/fulfilment/api/delivery.controller.ts#DeliveryController]
- `POST /api/shops/:shopId/deliveries`, `GET /api/shops/:shopId/deliveries`, `GET /api/shops/:shopId/deliveries/:id`, `POST /api/shops/:shopId/deliveries/:id/cancel`: shop requests, lists and cancels. [code: packages/backend/libs/domains/fulfilment/api/shop-delivery.controller.ts#ShopDeliveryController]
- Topics `delivery:<id>` (`status`, `courier_position`) and `user:<courierId>` (`delivery_offer`, `delivery_offer_withdrawn`, `delivery_cancelled`). [code: packages/backend/libs/domains/fulfilment/api/realtime-topics.ts#DELIVERY_TOPIC_PREFIX]
- Events `delivery.status_changed` (outbox, topic `delivery.events`) and `courier.locations_reported` (topic `courier`, key = city). [code: packages/contracts/src/fulfilment/delivery.ts#deliveryStatusChangedPayloadSchema]
- Queue `delivery-offer-timeouts`; jobs `fulfilment.compute-surge`, `fulfilment.recover-deliveries`, `fulfilment.apply-order-lifecycle`. [code: packages/backend/libs/domains/fulfilment/infra/delivery-jobs.ts#RECOVER_DELIVERIES_JOB]

## Rules
- **S20.R-01** A user MUST be able to register once as a courier with a city (`^[a-z0-9-]{2,40}$`) and a vehicle (`bike`, `scooter`, `car`); re-registration updates both, except that a `BUSY` courier or one holding a live offer answers `409` `courier_busy`. [proof: S20 AS-01] [code: packages/backend/libs/domains/fulfilment/application/courier.service.ts#CourierService]
- **S20.R-02** Only the courier MUST switch `OFFLINE` and `AVAILABLE`, atomically by a conditional update; a repeat is a no-op, `BUSY` answers `409` `courier_busy`, no profile answers `403` `courier_profile_required`; going `OFFLINE` with a live offer MUST withdraw the offer and dispatch again at once. [proof: S20 AS-02, S20 AS-26] [code: packages/backend/libs/domains/fulfilment/application/courier.service.ts#CourierService]
- **S20.R-03** `GET /couriers/me` MUST return the profile, the live offer (only while live) and the active delivery. [proof: S20 AS-13] [code: packages/backend/libs/domains/fulfilment/application/courier.service.ts#CourierService]
- **S20.R-04** A location batch MUST have 1 to 20 points with strict shape and at most 32 KB; points older than 300000 ms or more than 10000 ms ahead of the server clock MUST be dropped and counted; the rest MUST be accepted. [proof: S20 AS-05, S20 AS-06] [code: packages/backend/libs/domains/fulfilment/domain/location-window.ts#classifyPoint]
- **S20.R-05** The live position MUST change only for a point newer than the live one, together with the searchable-set membership, and the request MUST NOT write to Postgres; only an `AVAILABLE` courier is searchable and an `OFFLINE` courier's points are discarded. [proof: S20 AS-03, S20 AS-04, S20 AS-07] [code: packages/backend/libs/domains/fulfilment/application/location-ingest.service.ts#LocationIngestService]
- **S20.R-06** Every accepted point MUST reach the history once per courier and timestamp, kept 90 days; a failed produce MUST answer `503` `location_history_unavailable` after the live position was applied. [proof: S20 AS-10, S20 AS-12] [code: packages/backend/libs/domains/fulfilment/infra/courier-track.projector.ts#CourierTrackProjector]
- **S20.R-07** The history consumer MUST validate payload and version, dedupe, retry unprocessed items with backoff and full jitter, and dead-letter poison messages with a reason without partial acknowledgement. [proof: S20 AS-11, S20 AS-12] [code: packages/backend/libs/domains/fulfilment/infra/courier-track.projector.ts#CourierTrackProjector]
- **S20.R-08** Batches MUST be limited to 30 per minute per courier (fail open); the courier is identified only by the session and the city is the registered city. [proof: S20 AS-08, S20 AS-09] [code: packages/backend/libs/domains/fulfilment/rate-limit-policies.ts#fulfilmentRatePolicies]
- **S20.R-09** Dispatch MUST search eligible couriers around the pickup with radii 3, 6 and 12 km, rank by distance then courier id, consider at most 20 candidates per search, and offer to one at a time. [proof: S20 AS-14, S20 AS-18] [code: packages/backend/libs/domains/fulfilment/domain/candidate-ranking.ts#rankCandidates]
- **S20.R-10** A courier MUST be eligible only when `AVAILABLE`, with a position at most 60 seconds old, no live offer and not offered this delivery before. [proof: S20 AS-17] [code: packages/backend/libs/domains/fulfilment/domain/courier-eligibility.ts#isEligible]
- **S20.R-11** An offer MUST expire after 15 seconds and have one record; a decline or expiry MUST return the delivery to `REQUESTED`, exclude the courier permanently and dispatch again at once. [proof: S20 AS-14, S20 AS-15, S20 AS-16] [code: packages/backend/libs/domains/fulfilment/application/dispatch.service.ts#DispatchService]
- **S20.R-12** A courier MUST hold at most one live offer and one active assignment, enforced by the store of record also when the cache is lost. [proof: S20 AS-21, S20 AS-22] [code: packages/backend/libs/domains/fulfilment/infra/offer.repository.ts#OfferSqlRepository]
- **S20.R-13** Accept MUST need the offered courier and a live offer by the injected clock, and MUST set delivery `ASSIGNED`, the offer `ACCEPTED` and the courier `BUSY` in one transaction; a never-offered courier gets `404` `delivery_not_found`. [proof: S20 AS-23, S20 AS-24, S20 AS-25] [code: packages/backend/libs/domains/fulfilment/application/dispatch.service.ts#DispatchService]
- **S20.R-14** When nobody is eligible the attempt MUST be consumed and a retry scheduled in 20 seconds; after 8 attempts the delivery MUST be `CANCELLED` with reason `no_courier_available`. [proof: S20 AS-18, S20 AS-19, S20 AS-20] [code: packages/backend/libs/domains/fulfilment/application/dispatch.service.ts#DispatchService]
- **S20.R-15** The due time MUST be stored on the delivery and a recovery job MUST act on overdue offers and retries, so a lost timer or a crash delays but never strands a delivery. [proof: S20 AS-27] [code: packages/backend/libs/domains/fulfilment/application/recovery.service.ts#RecoveryService]
- **S20.R-16** The statuses and commands MUST follow the transition table exactly; `DELIVERED` and `CANCELLED` allow nothing; illegal moves MUST answer `409` `invalid_delivery_transition` with `currentStatus` and `command` and change nothing. [proof: S20 AS-28, S20 AS-30] [code: packages/backend/libs/domains/fulfilment/domain/delivery-state.ts#transition]
- **S20.R-17** Every transition MUST be one conditional update, one history row with actor kind and a version increment in one transaction; milestones `REQUESTED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED`, `CANCELLED` MUST write `delivery.status_changed` through the outbox in that transaction. [proof: S20 AS-29] [code: packages/backend/libs/domains/fulfilment/infra/delivery.repository.ts#DeliverySqlRepository]
- **S20.R-18** Courier actions by anyone but the assigned or offered courier MUST answer `404`; a repeat by the same courier MUST succeed with no new row, event or effect. [proof: S20 AS-31, S20 AS-33, S20 AS-34] [code: packages/backend/libs/domains/fulfilment/application/delivery-actions.service.ts#DeliveryActionsService]
- **S20.R-19** A shop member with `orders.manage` MUST be able to cancel a delivery in `REQUESTED`, `OFFERED` or `ASSIGNED`; the courier MUST be freed and told; open deliveries MUST also be cancelled when their order is cancelled or their shop deleted, a `PICKED_UP` one only flagged. [proof: S20 AS-32, S20 AS-35] [code: packages/backend/libs/domains/fulfilment/application/delivery-actions.service.ts#DeliveryActionsService]
- **S20.R-20** After commit the order MUST receive `startFulfilment`, `ship {trackingCode}` and `deliver` through its lifecycle service for single-shop orders only, retried by a job, an already reached status counting as success. [proof: S20 AS-36] [code: packages/backend/libs/domains/fulfilment/application/order-lifecycle.service.ts#OrderLifecycleService]
- **S20.R-21** A delivery request MUST take buyer, fee, surge and currency from the server, need `Idempotency-Key`, reject unknown fields, and need a paid, uncancelled order that contains the shop (`404` `order_not_found`, `409` `order_not_deliverable`). [proof: S20 AS-37, S20 AS-38, S20 AS-39, S20 AS-40] [code: packages/backend/libs/domains/fulfilment/application/delivery-request.service.ts#DeliveryRequestService]
- **S20.R-22** There MUST be at most one non-terminal delivery per order and shop, a route of at most 30 km, a served city, and at most 200 open deliveries per shop, race-free. [proof: S20 AS-41, S20 AS-42] [code: packages/backend/libs/domains/fulfilment/application/delivery-request.service.ts#DeliveryRequestService]
- **S20.R-23** Requests MUST be limited to 60 per minute per shop, failing closed. [proof: S20 AS-43] [code: packages/backend/libs/domains/fulfilment/rate-limit-policies.ts#fulfilmentRatePolicies]
- **S20.R-24** Reads MUST put the principal in the predicate: the buyer, the assigned courier and the courier holding the live offer see their own view, everyone else gets `404`; buyer views carry no courier id, courier views no buyer id, shop views no courier coordinates. [proof: S20 AS-44, S20 AS-45] [code: packages/backend/libs/domains/fulfilment/domain/delivery-views.ts#toBuyerView]
- **S20.R-25** The topic `delivery:<id>` MUST admit only the buyer and the assigned courier; status messages MUST be replayable without courier identity; positions MUST be throttled to one per 2 seconds, not replayed, and sent only while `ASSIGNED` or `PICKED_UP`; a push failure MUST NOT fail a transition. [proof: S20 AS-46, S20 AS-47, S20 AS-48] [code: packages/backend/libs/domains/fulfilment/application/delivery-push.service.ts#DeliveryPushService]
- **S20.R-26** The fee MUST be `(499 x surge + 50) / 100` in integer arithmetic from surge in hundredths 100 to 300 step 25; surge per geohash cell MUST come from demand over eligible supply, computed once per tick and expiring after 3 minutes. [proof: S20 AS-49, S20 AS-50] [code: packages/backend/libs/domains/fulfilment/domain/surge-fee.ts#feeForSurge]
- **S20.R-27** City ownership MUST be decided by a consistent hash ring with 128 virtual nodes; a non-owner hands a message back at most 3 times and then handles it; correctness MUST NOT depend on ownership. [proof: S20 AS-52, S20 AS-53] [code: packages/backend/libs/domains/fulfilment/domain/dispatcher-ring.ts#ownerOf]
- **S20.R-28** Every per-city key MUST carry the city as hash tag and one city's failure MUST NOT delay another. [proof: S20 AS-54] [code: packages/backend/libs/domains/fulfilment/infra/courier-keys.ts#keyShapes]
- **S20.R-29** `order.paid` and `order.cancelled` MUST maintain a deliverable-order copy guarded by the order version, idempotently, dead-lettering invalid payloads. [proof: S20 AS-55, S20 AS-56] [code: packages/backend/libs/domains/fulfilment/infra/deliverable-order.repository.ts#DeliverableOrderSqlRepository]
- **S20.R-30** The domain MUST count offers, attempts, give-ups, points, history failures, recovered timers and write-backs, with `fulfilment_double_assignments_total` derived from stored state, and MUST log without coordinates. [proof: S20 AS-57] [code: packages/backend/libs/domains/fulfilment/application/delivery-metrics.ts#DeliveryMetrics]
- **S20.R-31** The delivery tables MUST hold no foreign key to another domain, be registered under `domain:fulfilment`, and the barrel MUST export modules, DTO types and event contracts only. [proof: S20 AS-58] [code: packages/backend/db/ownership.ts#OWNERSHIP]

## Behaviors
- **S20.B-01** Given three eligible couriers, when a delivery is requested, then the nearest is offered with attempt 1 and a 15 second expiry. [proof: S20 AS-14]
- **S20.B-02** Given an offer, when the courier declines, then the next courier is offered and the first is never offered it again. [proof: S20 AS-15]
- **S20.B-03** Given a position 61 seconds old, when a delivery is requested, then the courier is skipped; at 60 seconds it is eligible. [proof: S20 AS-17]
- **S20.B-04** Given two deliveries and one courier, when both are requested at once, then exactly one is offered. [proof: S20 AS-21]
- **S20.B-05** Given an accepted delivery, when the courier picks up and delivers, then the history holds four transitions with increasing versions and the courier is available again. [proof: S20 AS-29]
- **S20.B-06** Given a lost timer message, when the recovery job runs after the due time, then the delivery moves on exactly once. [proof: S20 AS-27]
- **S20.B-07** Given `order.cancelled` before `order.paid`, when both are consumed, then the copy stays cancelled and a request answers `409`. [proof: S20 AS-56]
- **S20.B-08** Given demand of three requests and one courier, when the surge job runs, then a new request costs 1497 minor units. [proof: S20 AS-49]

## Lifecycles
A delivery is `REQUESTED`, `OFFERED`, `ASSIGNED`, `PICKED_UP`, `DELIVERED` or `CANCELLED` (table in R-16). A courier is `OFFLINE`, `AVAILABLE` or `BUSY` (`BUSY` only inside accept, finish and cancel transactions). An offer is `OFFERED`, then `ACCEPTED`, `DECLINED`, `EXPIRED` or `WITHDRAWN`.

## Owns
- Tables `Courier`, `Delivery`, `DeliveryEvent`, `DeliveryOffer`, `DeliverableOrder`. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Rate-limit policies `fulfilment.courier-locations`, `fulfilment.delivery-request`, `fulfilment.delivery-actions`.
- Events `delivery.status_changed` and `courier.locations_reported`; queue `delivery-offer-timeouts`; DynamoDB table `CourierTrack`.

## Decisions
- Offers and assignments are invariants of Postgres (partial unique indexes and conditional updates); Redis is a guard and an index and may be lost.
- The due time is stored on the delivery; the queue message is an accelerator and the recovery job the safety net.
- The order is told through its lifecycle service after commit and retried by a job; the order is read only through a copy built from its events.
- The fee uses integer hundredths so no float reaches money.

## Known gaps
- Load figures (50000 points per second, first offer p99, ring movement in a fleet, the 90 day expiry in a real environment, the crash drill, the status push latency) have no automated proof (listed in `specs/UNVERIFIED.md`).
- No web capability owns a courier app, a buyer tracking page or a seller screen, so no UI journey exists.
