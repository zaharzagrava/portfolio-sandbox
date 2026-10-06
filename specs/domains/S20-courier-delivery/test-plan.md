# Test Plan: S20 — Same-Day Courier Dispatch (domain `fulfilment`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (58 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/fulfilment/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `DeliveryModule`, `DeliveryWorkerModule` and `DeliveryProjectorModule` (queue messages, jobs and consumers are invoked through their real handlers, as other specs do) with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres, Redis, Kafka and SQS stand-ins and DynamoDB local from `docker-compose.test.yaml`, with real migrations, and call HTTP through `supertest`:
  - `courier-shift.e2e-spec.ts` — describe "Courier profile, shift and self view"
  - `courier-locations.e2e-spec.ts` — describe "Courier location ingest: window, order, shift gating and rate limit"
  - `courier-track-projector.e2e-spec.ts` — describe "Courier track history: consumer idempotency, poison messages and store faults"
  - `delivery-dispatch.e2e-spec.ts` — describe "Delivery dispatch: offers, timeouts, races, durable timers"
  - `delivery-lifecycle.e2e-spec.ts` — describe "Delivery lifecycle: state machine, replay, cancellation and order write-back"
  - `delivery-request.e2e-spec.ts` — describe "Delivery request: idempotency, tenant isolation and visibility"
  - `delivery-tracking.e2e-spec.ts` — describe "Delivery live tracking: subscription policy, throttle and replay"
  - `delivery-surge.e2e-spec.ts` — describe "Delivery surge pricing"
  - `delivery-city-ownership.e2e-spec.ts` — describe "Delivery city ownership and cell isolation"
  - `delivery-order-events.e2e-spec.ts` — describe "Delivery order events: deliverable-order copy"
  - `delivery-observability.e2e-spec.ts` — describe "Delivery metrics and logs"
- Users, shops, orders and products come only from the shared fixture helpers and the exported services of S01, S03 and S10; no spec injects `ShopModel`, `UserModel` or any other domain's model (D-7). Order events are produced with contract-valid fixtures of S10. Every test asserts the response body **and** persisted state (delivery, offer, history and courier rows, outbox rows, live-index state, track items, idempotency records, copies) and parses responses with the `packages/contracts` schema (VII.6).
- Only system edges are faked: identity token verification, the clock (frozen and advanced; no `Date.now()` in the tests), the order lifecycle service in the write-back fault case. Faults use real mechanisms: a Kafka producer pointed at a closed port, the track store behind a proxy that returns unprocessed items, an emptied queue, a deleted guard key, a latch inside a request, two real worker module instances, a limiter store switched off, an order service stub that throws.
- Consumers (`delivery.track` history consumer, `order.paid`, `order.cancelled`, `tenancy.shop_deleted`) each have the duplicate-delivery and invalid-payload tests of VII.4 (AS-10, AS-11, AS-35, AS-55).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): `delivery-state.spec.ts`, `location-window.spec.ts`, `surge-fee.spec.ts` (with `fast-check` for fee bounds and monotonicity), `geohash.spec.ts`, `dispatcher-ring.spec.ts` (with `fast-check` for movement bounds), `candidate-ranking.spec.ts`, `delivery-views.spec.ts` (which fields each view may contain). Controllers, repositories, consumers and glue get no unit tests.
- UI journey (Playwright): none. No web capability owns a courier screen, a buyer tracking page or a seller delivery screen (see `questions.md`, CONTRACT); VII.7 asks for a journey once per client that has the flow, so the column is empty until one exists.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-58).
- Gate 9 (VII.9): AS-09 (limiter store down), AS-12 (producer down; store returns unprocessed items; retries exhausted), AS-21 (guard keys lost), AS-27 (timer message lost; enqueue failed), AS-36 (order service fails), AS-48 (realtime store down), AS-43 (limiter fails closed), AS-54 (city fault) each force their fault.
- Concurrency tests use `Promise.all` and assert exactly one winner (or exactly N) and the invariant: AS-21, AS-22, AS-25, AS-33, AS-34, AS-41, AS-42; AS-40's in-flight case uses a latch.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 registration | `courier-shift.e2e-spec.ts`: 201 then 200 on change, `courier_busy` while BUSY or holding an offer, validation classes, 401, row persisted | — | — |
| AS-02 shift | `courier-shift.e2e-spec.ts`: available/offline, repeat no-op, BUSY 409 both ways, no profile 403, validation; stored status and searchable membership | — | — |
| AS-03 location batch | `courier-locations.e2e-spec.ts`: three unordered points, 202 body, live position and searchable set, one produced message sorted, no Postgres write (query counter) | — | — |
| AS-04 out of order and duplicate | `courier-locations.e2e-spec.ts`: late point `applied:false` but in history; identical batch twice; live unchanged | — | — |
| AS-05 time window | `courier-locations.e2e-spec.ts`: ±boundary points with frozen clock, dropped counts, empty result produces nothing | — | `location-window.spec.ts`: boundary table (−300 000, −300 001, +10 000, +10 001 ms) |
| AS-06 validation classes | `courier-locations.e2e-spec.ts`: `it.each` over every invalid class incl. `courierId`/`city` fields, 413 over 32 KB; nothing stored or produced | — | — |
| AS-07 shift gating | `courier-locations.e2e-spec.ts`: BUSY updates position and history tag but not searchable; OFFLINE `off_shift`, nothing stored | — | — |
| AS-08 identity | `courier-locations.e2e-spec.ts`: 401, 403 `courier_profile_required`, registered city used | — | — |
| AS-09 rate limit | `courier-locations.e2e-spec.ts`: 31st → 429 + `Retry-After`, other courier fine; limiter store off → allowed, fallback counted | — | — |
| AS-10 history duplicate delivery | `courier-track-projector.e2e-spec.ts`: same message twice and duplicate key inside a batch → three items, fields, expiry +90 d | — | — |
| AS-11 history invalid payload | `courier-track-projector.e2e-spec.ts`: bad `lat`, missing `courierId`, bad `ts`, unknown version → dead-lettered, valid siblings written | — | — |
| AS-12 history faults | `courier-track-projector.e2e-spec.ts`: unprocessed items twice → retried with backoff, stored once; exhausted → DLQ; producer down → 503 `location_history_unavailable`, live applied, resend yields one record per point | — | — |
| AS-13 courier self view | `courier-shift.e2e-spec.ts`: current offer present only while live, active delivery, 403, 401, schema parse | — | — |
| AS-14 nearest first, offer contents | `delivery-dispatch.e2e-spec.ts`: C1 offered, attempt 1, expiry T+15 s, offer record, queued timer delay, `delivery_offer` push, history row | — | — |
| AS-15 decline moves on | `delivery-dispatch.e2e-spec.ts`: 204, DECLINED, C2 offered attempt 2, C1 never re-offered even after the cache of declined was flushed | — | — |
| AS-16 offer timeout | `delivery-dispatch.e2e-spec.ts`: timer at T+15 s → EXPIRED, next courier, withdrawal push; duplicate and stale timers change nothing | — | — |
| AS-17 position freshness | `delivery-dispatch.e2e-spec.ts`: 61 s skipped, 60 s eligible, fresh ping eligible, never-pinged not eligible | — | — |
| AS-18 widening radii, ranking | `delivery-dispatch.e2e-spec.ts`: C5 found in 6 km step, C4 not found → attempt+1 and 20 s retry, C1 before C5, candidate cap | — | `candidate-ranking.spec.ts`: distance then ID order, cap at 20 |
| AS-19 empty search retry | `delivery-dispatch.e2e-spec.ts`: retry offers a newly eligible courier; stale retry ignored | — | — |
| AS-20 giving up | `delivery-dispatch.e2e-spec.ts`: 8th attempt → CANCELLED `no_courier_available`, push, outbox, no timer, late timer no-op | — | — |
| AS-21 one live offer per courier | `delivery-dispatch.e2e-spec.ts`: two deliveries race for one courier, also with guard keys deleted; one OFFERED, one REQUESTED with retry | — | — |
| AS-22 one active assignment per courier | `delivery-dispatch.e2e-spec.ts`: BUSY never offered even with a stale index entry; forced double accept → one ASSIGNED, `409 courier_busy` | — | — |
| AS-23 accept | `delivery-dispatch.e2e-spec.ts`: 200 courier view, courier BUSY and out of index, offer ACCEPTED, history, outbox ASSIGNED, buyer push, timer later no-op | — | — |
| AS-24 accept guards | `delivery-dispatch.e2e-spec.ts`: 404 never offered, `offer_not_active`, `offer_expired`, cancelled → `invalid_delivery_transition`, 401, 400 | — | — |
| AS-25 accept races | `delivery-dispatch.e2e-spec.ts`: accept vs timeout and accept vs cancel with `Promise.all`; one winner, never ASSIGNED plus live offer | — | — |
| AS-26 off shift during offer | `delivery-dispatch.e2e-spec.ts`: offer EXPIRED `courier_offline`, next courier at once | — | — |
| AS-27 durable timers | `delivery-dispatch.e2e-spec.ts`: queue emptied → recovery job expires offer; enqueue failed → retry dispatched; job twice and with late timer → one effect | — | — |
| AS-28 transition table | — | — | `delivery-state.spec.ts`: `it.each` over 6 statuses × 6 commands, exact allowed set, terminal states, unknown command throws (type-level `assertNever` checked by `tsc`) |
| AS-29 full happy path | `delivery-lifecycle.e2e-spec.ts`: accept → picked-up → delivered, 204s, history rows with versions, courier AVAILABLE, outbox per milestone, none for churn, pushes | — | — |
| AS-30 illegal transitions | `delivery-lifecycle.e2e-spec.ts`: `it.each` over the listed (status, command) pairs → 409 `invalid_delivery_transition`, nothing changed | — | — |
| AS-31 actor guards | `delivery-lifecycle.e2e-spec.ts`: other courier, buyer, other user → 404; 401 | — | — |
| AS-32 cancel by the shop | `delivery-lifecycle.e2e-spec.ts`: cancel in REQUESTED, OFFERED, ASSIGNED with effects; 409 later; 403 viewer; 404 other shop; 400 reason; 401 | — | — |
| AS-33 replay of courier actions | `delivery-lifecycle.e2e-spec.ts`: accept ×2 and concurrently, decline, picked-up, delivered replays → same body, one row/event; beyond target → 409 | — | — |
| AS-34 concurrent steps | `delivery-lifecycle.e2e-spec.ts`: picked-up ×2 → one row; picked-up vs cancel → one winner | — | — |
| AS-35 order cancelled or shop deleted | `delivery-lifecycle.e2e-spec.ts`: both consumers, open deliveries cancelled, PICKED_UP flagged, duplicate one effect, invalid payload dead-lettered | — | — |
| AS-36 order write-back | `delivery-lifecycle.e2e-spec.ts`: commands in order after commit, already-reached treated as success, order service fails 3× then succeeds (forces fallback), multi-shop sends nothing, `OrderNotFoundError` dead-lettered | — | — |
| AS-37 request, happy path | `delivery-request.e2e-spec.ts`: 201 + `Location`, schema, buyer from order, fee and surge fixed, history and outbox row in the same transaction, first dispatch ran | — | — |
| AS-38 validation classes | `delivery-request.e2e-spec.ts`: `it.each` over every class incl. `buyerId`/`feeMinor` fields, `route_too_long`, `city_not_served`, 401, 403 | — | — |
| AS-39 order rules and tenant isolation | `delivery-request.e2e-spec.ts`: foreign/unknown order 404, other shop's member, cancelled 409, open 409, delivered 409, after cancel allowed | — | — |
| AS-40 idempotency | `delivery-request.e2e-spec.ts`: replay, in-flight (latch), different body, missing and malformed key; one row, one outbox, one dispatch | — | — |
| AS-41 concurrent requests for one order | `delivery-request.e2e-spec.ts`: `Promise.all` ×2 → one 201, one `delivery_already_open` | — | — |
| AS-42 open-delivery limit | `delivery-request.e2e-spec.ts`: 200 open → 409; 199 + race → exactly one | — | — |
| AS-43 request rate limit | `delivery-request.e2e-spec.ts`: 61st → 429 + `Retry-After`; limiter store off → 503 and no row | — | — |
| AS-44 who can see a delivery | `delivery-request.e2e-spec.ts`: buyer, courier, offered courier views; strangers, declined courier, other shop → 404; 401; 400; `GET /orders/O1/deliveries`; stale flag | — | `delivery-views.spec.ts`: field allowlist per view |
| AS-45 shop reads | `delivery-request.e2e-spec.ts`: 45 rows paged 20/20/5, filter, validation classes, detail with history, other shop 404, 401 | — | — |
| AS-46 subscription policy | `delivery-tracking.e2e-spec.ts`: buyer and courier allowed; B2, past offered courier, shop member, anonymous, unknown ID denied | — | — |
| AS-47 position push throttle | `delivery-tracking.e2e-spec.ts`: 1 ping/s for 5 s → 2 pushes, not in the replay stream, none outside ASSIGNED/PICKED_UP, none after end | — | — |
| AS-48 status push, replay | `delivery-tracking.e2e-spec.ts`: status per transition in replay stream without courier identity; realtime store down → transition commits, failure counted | — | — |
| AS-49 surge compute | `delivery-surge.e2e-spec.ts`: 3 requests/1 courier → 3.0 and fee 1 497; old requests ignored; expiry after 3 min → 1.0; two workers, one computation per tick | — | — |
| AS-50 fee math | — | — | `surge-fee.spec.ts`: step table, `fast-check` integer / bounds / monotonic |
| AS-51 cell hash | — | — | `geohash.spec.ts`: canonical vectors, cell edge, extremes |
| AS-52 ring | — | — | `dispatcher-ring.spec.ts`: determinism, order independence, share 10–30 %, add 8–25 % all to new, remove moves only its own, empty set (`fast-check` over 1 000 cities) |
| AS-53 ownership in operation | `delivery-city-ownership.e2e-spec.ts`: two worker instances, non-owner hands back ≤ 2 s and after 3 hand-backs handles, heartbeat expiry moves ownership, jobs only on owned cities, empty set → all | — | — |
| AS-54 cell isolation | `delivery-city-ownership.e2e-spec.ts`: key and message-key inspection; faulting city `a` leaves city `b` offers and timeouts normal, failures counted per city | — | — |
| AS-55 `order.paid` consumer | `delivery-order-events.e2e-spec.ts`: copy created; twice → no change; invalid payloads dead-lettered | — | — |
| AS-56 out of order | `delivery-order-events.e2e-spec.ts`: cancelled(6) before paid(4) → CANCELLED, request 409; higher paid version updates; equal/lower ignored | — | — |
| AS-57 metrics and logs | `delivery-observability.e2e-spec.ts`: counters by outcome after a scripted run, double-assignment counter 0, log lines carry ids and no coordinates | — | — |
| AS-58 domain isolation | Static gate: `check:table-ownership --strict`, `check:boundaries`, ownership registry test (every new table registered), barrel export list | — | — |
