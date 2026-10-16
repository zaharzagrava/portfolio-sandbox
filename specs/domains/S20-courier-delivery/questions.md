# Questions and defaults: S20 — Same-day courier dispatch (domain `fulfilment`)

Decided without asking (decision policy: most production-grade option the notes and the constitution support). Sorted by impact; review BREAKING and CONTRACT first.

## BREAKING

- [BREAKING] `buyerId` is taken from the request body and `orderId` is optional (`api/delivery.controller.ts:35-41`, `application/dispatch.service.ts:61-86`), so a shop member can create a delivery for any user and any order → `orderId` required; the buyer comes from a fulfilment-owned copy of `order.paid`; the order must be paid, contain the shop and not be cancelled; unknown fields (`buyerId`, fee, surge) are refused → III.4, V.4 (tenant isolation, spoofing), IX.7 R3.
- [BREAKING] `POST /shops/:shopId/deliveries` has no `Idempotency-Key`, no uniqueness per order, no route or open-delivery limits, accepts any `city` string → `Idempotency-Key` required (422 without), one non-terminal delivery per `(order, shop)` by constraint, route ≤ 30 km, city must have a registered courier, ≤ 200 open deliveries per shop → V.6 (it creates a booking), III.6.
- [BREAKING] `GET /deliveries/:id` answers `403` to non-parties and returns the raw row (`offeredCourierId`, `attempt`, `version`, `feeCents`) plus `courierPosition` (`delivery.controller.ts:82-88`) → `404` for non-parties and role-based views (buyer, courier, shop); no courier ID to the buyer, no buyer ID to the courier; position only in `ASSIGNED`/`PICKED_UP` and flagged stale after 60 s → V.1 (explicit DTOs), V.4 (hide existence), privacy of GPS.
- [BREAKING] Money field `feeCents` (INTEGER column, `migrations/20261001280000-courier-delivery.js:32`) → `feeMinor` BIGINT plus `currency` taken from the order; fee = `round_half_up(499 × surge)` in integer arithmetic (`dispatch.service.ts:79` uses `Math.round` over a float surge) → III.8.
- [BREAKING] Cross-domain foreign keys `Courier.id → User`, `Delivery.shopId → Shop`, `Delivery.buyerId → User` with `ON DELETE CASCADE` on history (`migration:12,21,23,44`) → dropped by an expand/contract migration (plain ID columns); shop deletion is handled by the `tenancy.shop_deleted` consumer → IX.4, IX.9.
- [BREAKING] Offers live only in Redis plus two columns on `Delivery` (declined set in Redis with a 1 h TTL, `dispatch.service.ts:97,194`); the "one live offer per courier" and "one assignment per courier" invariants rest on a Redis `SET NX` and a non-atomic Redis/Postgres status write (`courier.service.ts:60-63`, `dispatch.service.ts:145-146`) → new offer-record table; partial unique indexes (one live offer per courier, one active assignment per courier); `Courier.status = BUSY` written in the accept transaction; Redis stays a guard and index only → III.6 (invariants in one strongly consistent store), notes: "atomic courier state".
- [BREAKING] Timers exist only as SQS delayed messages enqueued after commit (`dispatch.service.ts:117,130`); a crash between commit and enqueue strands a delivery → due time stored on the delivery plus a recovery job (every 15 s) → III.3, VIII.6, SC-004.
- [BREAKING] Location endpoint is `skipThrottle` and answers `{accepted, applied}`; an `OFFLINE` courier's positions are stored; a failed Kafka produce is an unhandled 500 (`delivery.controller.ts:66`, `courier.service.ts:65-79`) → rate limit `fulfilment.courier-locations` (30/min, fail open), response `{accepted, dropped: {stale, future}, applied, reason?}`, off-shift positions discarded, `503 location_history_unavailable` on produce failure → privacy of off-shift couriers, VIII (observability), V.3.
- [BREAKING] A courier that stops pinging stays in the geo index forever (the position hash expires after 300 s, the index entry does not, `infra/courier-keys.ts:25-33`) → eligibility requires a position ≤ 60 s old; the recovery job prunes stale entries → dispatch quality, wasted offers.
- [BREAKING] There is no cancel endpoint and `cancel` is reachable only after 8 failed attempts (`dispatch.service.ts:92-96`) → `POST /shops/:shopId/deliveries/:id/cancel`, `order.cancelled` and `tenancy.shop_deleted` consumers; courier freed and notified → a shop must be able to withdraw a request; notes: state machine includes `CANCELLED`.
- [BREAKING] Error vocabulary: Nest `BadRequestException('Finish the current delivery first')` (400), `NotFoundException('Not a courier')` (404), `ConflictException('Offer expired or not yours')` (409) with free text → problem+json with stable codes (`courier_busy` 409, `courier_profile_required` 403, `offer_not_active` 409, `offer_expired` 409, `delivery_not_found` 404, `invalid_delivery_transition` 409, `order_not_found` 404, `order_not_deliverable` 409, …); accept or decline by a courier who was never offered → `404` (was `409`) → V.3, V.4.
- [BREAKING] Repeating `accept`, `picked-up` or `delivered` answers `409` today (`dispatch.service.ts:188`) → the same courier repeating an applied action gets the same success (no new row or event) → mobile retries on flaky networks.
- [BREAKING] `RegisterCourierDto` lets a courier change city or vehicle while `BUSY` (`courier.service.ts:34-40`, upsert) and `setAvailability` reads then writes (`courier.service.ts:52-58`) → `409 courier_busy`, atomic conditional switch → III.6, III.7.
- [BREAKING] The controller writes to Redis (`CITIES_KEY`, `delivery.controller.ts:55`) and the surge job reads the city list from it (`infra/delivery-workers.ts:91-93`) → "served cities" come from `Courier` rows; controller makes one service call → II.1.
- [BREAKING] Realtime: status pushes carry `courierId` and free-text reasons with no version; position pushes are not limited to `ASSIGNED`/`PICKED_UP`; the `delivery:` policy runs raw SQL in `api/` and lets only buyer and courier subscribe (`api/realtime-topics.ts:19`, `dispatch.service.ts:94,147,189`) → `status {status, deliveryVersion, at}` (replayed), no courier identity, position only on the way, policy through a repository port with the principal in the predicate → V.1, I.2, privacy.
- [BREAKING] Event `courier.locations_reported` is created with version 0 and `courierId` as aggregate (`application/events/courier-events.ts`, `courier.service.ts:77`) and the history consumer silently drops payloads that do not match (`delivery-workers.ts:55-58`) → version 1, envelope per IV.4, invalid payloads dead-lettered with a reason → IV.5.
- [BREAKING] Barrel and apps wire infrastructure internals (`index.ts` exports `CourierTrackProjector`; `DeliveryWorkerModule` exports `SurgeJob` and `OfferTimeoutWorker`; `apps/projector` imports the projector class) → `DeliveryProjectorModule` and the modules only; services and projectors are not exported → X.4, debt D-8.
- [BREAKING] `delivery.e2e-spec.ts` calls services directly, imports `ShopModel` (`:10`), stubs the Kafka producer (`:49`) and uses real time → HTTP e2e per `test-plan.md`, fixtures and exported services only, frozen clock → VII.2, VII.3, D-7.

## CONTRACT

- [CONTRACT] S10 lists S19 as the consumer of `order.paid → dispatch` and S19, S20 as users of `OrderFulfilmentService.apply` → S20 is the consumer; S19 consumes neither (S19's questions already say so); S10's contract line should read "Consumers: S20" for the order events and "S20" for `apply` → keeps the owner list true.
- [CONTRACT] `order.paid` carries no address, so "consumes `order.paid` for dispatch" (domain map) cannot start a dispatch → `order.paid` and `order.cancelled` maintain a deliverable-order copy (R3); the shop supplies coordinates; automatic dispatch needs an address in S10 → domain-map wording to read "consumes `order.paid`/`order.cancelled` to know which orders are deliverable".
- [CONTRACT] Order write-back → `startFulfilment` on first `ASSIGNED`, `ship {trackingCode: deliveryId}` on `PICKED_UP`, `deliver` on `DELIVERED`, after commit, retried by a job, treating an order already at or past the target as success, single-shop orders only → S10 owns the order guard (R1 write through its exported service, as S10's questions decided); multi-shop per-shop fulfilment stays a S10 non-goal.
- [CONTRACT] S28 gets `delivery.status_changed` v1 (payload in `spec.md`) for buyer and seller notifications → one event per milestone, no offer churn; S28 should not read delivery tables.
- [CONTRACT] S51 must serve `user:<courierId>` (self only) for `delivery_offer`, `delivery_offer_withdrawn`, `delivery_cancelled` and keep a replay window for `delivery:<id>` status → this capability defines only the `delivery:` policy.
- [CONTRACT] S50 registers `fulfilment.courier-locations`, `fulfilment.delivery-request`, `fulfilment.delivery-actions`; S49 registers `fulfilment.compute-surge`, `fulfilment.recover-deliveries`, `fulfilment.apply-order-lifecycle`; S54's idempotency facility is used for `POST /shops/:shopId/deliveries` → names fixed here.
- [CONTRACT] S03 permissions `orders.manage` (request, cancel) and `orders.read` (shop reads) are reused; no new permission → matches S03's matrix.
- [CONTRACT] S48 composes the order page from `GET /orders/:orderId/deliveries` (R2) → new buyer endpoint; no export from this domain to orders.
- [CONTRACT] No web capability (W01–W07) owns a courier app, a buyer tracking page or a seller delivery screen → no UI journey is planned in `test-plan.md`; a web capability must be added before one can be (VII.7: once per client that has the flow).
- [CONTRACT] S01 publishes no account-deletion event → courier and delivery rows keep plain user IDs; a later `identity.user_deleted` would add a consumer here.

## LOCAL

- [LOCAL] Offer timeout 15 s, retry 20 s, 8 attempts, radii 3/6/12 km, 20 candidates → kept from the notes and the draft.
- [LOCAL] Position freshness 60 s, window 5 min / +10 s, batch ≤ 20, body ≤ 32 KB → draft values, plus the size cap.
- [LOCAL] Route ≤ 30 km, ≤ 200 open deliveries per shop (advisory lock per shop for a race-free count) → "same-day local" bound; sized for one shop.
- [LOCAL] Declined/expired couriers are excluded for the whole life of the delivery (offer records), no TTL → a courier asked twice is a worse failure than a slower match.
- [LOCAL] Ring: 128 virtual nodes, instance heartbeat 10 s with 30 s expiry, 3 hand-backs of ≤ 2 s → ownership is only an optimisation; correctness rests on the store.
- [LOCAL] Surge cell = geohash precision 5, demand window 10 min, expiry 180 s, steps 0.25, clamp 1–3 (draft) → expiry makes a dead job fall back to 1.0.
- [LOCAL] Positions of `OFFLINE` couriers are discarded and `BUSY` couriers are tracked but not searchable → privacy and index hygiene.
- [LOCAL] Offer churn emits no outbox event; five milestones do → consumers care about milestones.
- [LOCAL] Courier cannot un-assign, no geofence or proof of delivery, ranking by straight-line distance behind a replaceable function → not in the notes' scope.
- [LOCAL] History is write-only (no read API); 90-day expiry kept → disputes use tooling.
- [LOCAL] Hot-city sub-key sharding not built → scale-out step, same behaviour.
- [LOCAL] Realtime push is best effort after commit; a failure is counted, never rolls back → III.3.

## Notes from Phases 0-2 (no blocker)

- [LOCAL] `orderId NOT NULL` and `feeMinor NOT NULL` are applied by the contract step, not the expand step, so the draft request path keeps working until T043/T058 replace it (see tasks.md Phase 0-2 notes).
- [LOCAL] `DeliverableOrder.currency` is nullable: `order.cancelled` (which can arrive first, AS-56) carries no currency.
- [LOCAL] `DeliveryEvent."from"` is nullable: the creation row has no previous status (`previousStatus: null` in the event).

## Notes from Phase 3 (no blocker)

- [LOCAL] The location hot path reads the courier profile by primary key (one indexed SELECT, no write) for city and status instead of a session-cached profile: the principal carries no courier data. A profile cache keyed by user can replace the read later behind the same CourierRepository.find without changing behaviour; FR-009 (no Postgres write) holds.
- [LOCAL] The track throttle push of the draft (courier_position) was removed from ingest with the draft CourierService.report; it returns with US7 (T070-T072) using trackThrottleKey(city, deliveryId) (now hash-tagged).
- [LOCAL] CourierTrack puts use BatchWriteItem (no per-item condition is possible there): a put with the same (courier, day, ts) key is the same item, so idempotency is natural; duplicates inside one batch are removed first.
- [LOCAL] CourierService keeps deprecated get/setStatus/position for the draft DispatchService until T044 removes it; the old delivery.e2e-spec.ts was adapted to register/setAvailability/LocationIngestService signatures. (Removed in Phase 4: both the deprecated methods and the old spec are gone.)

## Notes from Phases 4-5 (no blocker)

- [LOCAL] AS-30 lists `delivered` on a `DELIVERED` delivery among the 409s while AS-33 says a repeated `delivered` is `204`: the replay (AS-33, FR-025) wins. AS-30's "picked-up on PICKED_UP by another actor" is AS-31's `404`. Beyond-target moves (`picked-up` on `DELIVERED`) stay `409`.
- [LOCAL] A courier who is not the delivery's courier but holds or held an offer for it is "related": a wrong move answers `409 invalid_delivery_transition`; a stranger answers `404` (V.4). This is how AS-30's `picked-up on REQUESTED/OFFERED` can be a 409 at all (no courier is assigned yet).
- [LOCAL] AS-25 "accept and shop cancel race, exactly one wins": cancel from `ASSIGNED` is legal (AS-32), so an accept that commits first is followed by a successful cancel; the end state is `CANCELLED` and a free courier in both orders. The test asserts that invariant plus "one ASSIGNED row or one refused accept".
- [LOCAL] AS-22 "two accepts racing for two deliveries offered to one courier" cannot be built through the API because the unique index refuses a second live offer; the test seeds the second offer after the first is `ACCEPTED` (what a faulted guard plus an expiry could leave) and races two accepts of it: both answer `409 courier_busy`.
- [LOCAL] Offer expiry by timer message acts only when the stored `expiresAt <= now`; a message that arrives early (clock skew between instances) is a no-op and the recovery job (every 15 s) catches the offer up.
- [LOCAL] Recovery claims an overdue delivery with a 30 s lease (`nextActionAt` pushed ahead in a short transaction) and acts outside the transaction, because dispatch searches Redis and no network call may run inside a transaction (FR-051).
- [LOCAL] The offer record of a cancelled `OFFERED` delivery becomes `EXPIRED` (AS-32); `WITHDRAWN` is not used by any current path.
- [LOCAL] `tenancy.shop_deleted` flags an in-transit delivery with the history note `shop_deleted_in_transit`, mirroring `order_cancelled_in_transit`.

## Notes from Phases 6 and 8 (no blocker)

- [LOCAL] AS-56 says a request for an order whose cancel arrived before its payment answers `409 order_not_deliverable`, while FR-030 says an order that does not contain the shop is `404 order_not_found`. A copy created by `order.cancelled` alone knows no shops, so the request path answers 409 for a `CANCELLED` copy with an empty shop list and 404 when the shop list is known and lacks the shop. The cost is that any shop member who guesses the UUID of such a cancelled order learns it is cancelled (no buyer or content data); the alternative (404) contradicts AS-56.
- [LOCAL] AS-39 "a member of another shop gets 404 or 403 per the shop gate": the S03 gate answers `404 shop_not_found` for a non-member, so the test asserts 404. `delivery_not_found` is the answer of the shop's own lookups for a delivery of another shop.
- [LOCAL] AS-38 order of checks: body validation (400) first, then the order rules (404/409), route length, served city (422), then the surge read and the transaction. A request that is wrong in several ways gets the first class in that order.
- [LOCAL] At 200 open deliveries a duplicate request for an order that already has an open delivery answers `open_delivery_limit` (the count runs before the insert, under the shop lock), not `delivery_already_open`.
- [LOCAL] `@Idempotent` replays only responses the platform stores (successes); business 4xx are recomputed on retry (an unchanged order state gives the same answer). The first dispatch after commit can fail without failing the request: the delivery stays `REQUESTED` with `nextActionAt = now` and the recovery job offers it.
- [LOCAL] The demand window of `RedisSurgeStore` is ten one-minute buckets (granularity one minute).

## Notes from Phases 7, 9, 10 and 11 (no blocker)

- [LOCAL] AS-47 says one ping per second for 5 s gives 2 `courier_position` pushes. With a closed window (a push at `t` blocks every push up to and including `t + 2 s`) pings at 0, 1, 2, 3, 4 s push at 0 and 3 s: 2 messages, and any closed 2 s interval holds at most one. An open window would push at 0, 2 and 4 s (3 messages), so the closed one matches the scenario; the throttle compares the caller's clock, not the store's, so it is deterministic under a frozen clock.
- [LOCAL] FR-043 (recovery and surge handled by the owner) and AS-49 (each schedule tick computed once by the job-table claim) pull in opposite directions: a once-per-tick job runs on ONE instance, so owner-only processing would leave the cities of every other instance uncovered. Resolution: the claiming instance covers its own cities and queues one follow-up job per other live instance (`for`), so each city is processed once per tick by a job that is claimed once. The cost is one extra job row per peer per tick.
- [LOCAL] A worker that is not in a non-empty instance set (its heartbeat is late) owns no city; its timer messages are handed back and handled after 3 hand-backs, and the jobs of the instances that are listed cover its cities. An unreadable or empty set makes it process everything (fail open).
- [LOCAL] Hand-back delay is 1 s (SQS delays are whole seconds; the spec allows at most 2 s).
- [LOCAL] AS-57 asks for rate-limited batches in the delivery metrics; the global limiter interceptor runs before any route-level interceptor, so the capability cannot observe its own 429. The limiter's `rate_limit_decisions_total{policy="fulfilment.courier-locations", allowed="false"}` is that count and the dead `courier_location_batches_rate_limited_total` instrument is removed. `courier_history_failures_total` has the stages `produce` and `store`; a poison message is dead-lettered by the consumer framework, which counts it.
- [LOCAL] Surge supply is the searchable set of the city with a position at most 60 s old; a courier that holds a live offer is still in that set, so it counts as supply until it answers (the offer guard does not remove it). The demand window is ten one-minute buckets, so a request drops out between 9 and 10 minutes after it was made (never later than 10).
- [LOCAL] The 180 s expiry of the surge map is the store's own key expiry (real time); the spec asserts the TTL and removes the key to simulate expiry because the frozen clock does not move Redis.
- [LOCAL] The e2e specs of ownership and observability boot a second worker-shaped Nest app in the same process (`testing/worker-instance.ts`) instead of a separate OS process; they share the spec's frozen clock and the real Postgres and Redis.

## Notes from Phase 12 (no blocker)

- [LOCAL] Nothing runs `migrations/contract/` automatically (`db:migrate` and `db:jest:migrate:up` do not recurse), as for the S15, S16 and catalog-import contract files. The S20 contract step was applied by hand to the test DB (`pnpm db:jest:migrate:up --migrations-path migrations/contract`); that command also applied the three other pending contract files of the folder (S15, S16, catalog import) to the test DB. Because a fresh stack only runs the expand step and the code no longer writes `feeCents` (NOT NULL in the draft table), a small bridge migration `migrations/20261017100050-delivery-s20-fee-cents-nullable.js` drops that NOT NULL; the contract step then drops the column. The dev DB was not touched and `db:migrate:down` was not run.
- [LOCAL] D-6 ("no `infra/` import in `application/`"): `DeliveryMetrics` moved from `infra/` to `application/delivery-metrics.ts` (instrumentation, no store); the `[code:]` anchor of S20.R-30 follows.
- [LOCAL] T083: the pattern-map rule goes `implemented` -> `verified` (the `spec'd` state sits below `implemented`), so P0110, P0323, P0328 and P1105 stay `implemented`; noted in gaps.md.
- [LOCAL] `specs/UNVERIFIED.md` had SC-006 and SC-009 in one row; split into two rows.
- [LOCAL] `index.ts` exports `DeliveryStatusChanged`, `DELIVERY_AGGREGATE`, `CourierLocationsReported` and the delivery DTO types besides the modules.
