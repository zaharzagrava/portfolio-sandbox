---
description: "Task list for S22 — Launch-Event Booking (domain launch-events)"
---

# Tasks: S22 — Launch-Event Booking

**Input**: plan.md, spec.md, test-plan.md, gaps.md (G-01…G-44, D-6/D-7/D-8, IX.4 FK), questions.md, data-model.md, research.md, contracts/
**Tests**: Requested (test-plan.md, 62 rows). For each row the failing test task comes before the code task.
**Format**: `- [X] T### [P?] [US?] Description with path`. `[P]` = different files, no dependency on an unfinished task.

Path shorthands: `LE` = `packages/backend/libs/domains/launch-events`; `C` = `packages/contracts/src/launch-events`; `MIG` = `packages/backend/db/migrations`. Run backend commands from `packages/backend`; e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path> [-t "AS-nn"]`. No runtime-proof tasks (fresh stack, standalone boot, journeys, k6 runs) are listed: they are deferred to the final checkpoint. SC-004/SC-009 are ops artifacts already in quickstart.md and `specs/UNVERIFIED.md` (rows exist, status "not run").

## Phase 1: Setup

- [X] T001 Record the baseline: run `pnpm --dir packages/backend check:table-ownership` and note the `launch-events` lines against gaps.md §3 (re-run after finishing, T071). Do not alter `.ownership.baseline`.
- [X] T002 Create the living-spec page `docs/spec/capabilities/S22-launch-event-booking.md` (rules and behaviours first, with `[proof: …]`/`[code: …]` markers pointing at the e2e files and modules below); run `python3 scripts/livespec/check.py`. Never touch any `*.reviewed.json`.
- [X] T003 [P] Add `LE/domain/errors.ts`: domain error classes carrying the FR-051 `code` and HTTP status (`ADMISSION_REQUIRED` 403, `HUMAN_CHECK_FAILED` 403, `EVENT_NOT_FOUND`/`TICKET_NOT_FOUND`/`HOLD_NOT_FOUND` 404, `EVENT_NOT_ON_SALE`/`EVENT_SOLD_OUT`/`EVENT_CLOSED`/`EVENT_ALREADY_CLOSED`/`SEAT_TAKEN {seat}`/`NO_SEATS_AVAILABLE`/`HOLD_EXPIRED`/`HOLD_RELEASED`/`HOLD_ALREADY_CONFIRMED` 409, `TICKET_LIMIT_EXCEEDED {limit, remaining}`/`UNKNOWN_SEAT`/`SEATS_NOT_SELECTABLE`/`invalid_schedule` 422, `WAITING_ROOM_FULL`/`WAITING_ROOM_UNAVAILABLE`/`HOLDS_UNAVAILABLE` 503; full list and statuses from spec.md FR-051) mapped by the S54 problem filter (G-39). No free-text-only exceptions.

## Phase 2: Foundational (blocks all stories)

- [X] T004 [P] Contracts: add `C/` schemas `launchEventSchema` (public + organizer variants), `createLaunchEventRequestSchema`, `queueStatusSchema` (position, queueLength, etaSeconds, heartbeatSeconds, expiresAt, admitted, admissionToken, tokenExpiresAt), `holdSeatsRequestSchema` (`seats` xor `quantity`, ≤ 10), `holdSchema`, `confirmResponseSchema`, `bookingPageSchema`, `myBookingsSchema`, `seatMapSchema` (seatCount, seatsPerRow, seq, bitmap), `seatMapDeltaSchema {seq, change: held|booked|released, seats[]}`, the four event payload schemas and the voucher command schema from `contracts/events-and-commands.md`, and the error-code constants; export from the contracts index (FR-049, AS-59, AS-62).
- [X] T005 [P] Write failing unit spec `C/seat-map-reducer.spec.ts` (AS-47): sequence `11, 13, 12, 12` table with `it.each` (apply last+1, ignore ≤ last, refetch on gap, no double apply).
- [X] T006 Implement `C/seat-map-reducer.ts` to make T005 pass.
- [X] T007 [P] Migration `MIG/<ts>-launch-events-drop-shop-fk.js` (G-37): drop `REFERENCES "Shop"("id")` on `LaunchEvent.shopId` with `lock_timeout`; keep `shopId UUID NOT NULL`; expand-only, with `down`.
- [X] T008 [P] Migration `MIG/<ts>-launch-events-booking-v2.js` (expand only): `LaunchEvent` add `seatingMode` (`SEATED|GENERAL`, default `SEATED`), `humanCheckRequired` (default false), `closedReason` (`organizer|started`, nullable), `perUserLimit` (1–10, default 2) and `seatsPerRow` if absent; create `LaunchEventHistory` (`id`, `launchEventId`, `fromStatus`, `toStatus`, `reason`, `at`; index (`launchEventId`,`at`)); create `BookingEvent` (`id`, `bookingId`, `fromStatus` nullable, `toStatus`, `holdId`, `at`); `Booking` indexes (`launchEventId`,`confirmedAt DESC`,`id DESC`) and (`launchEventId`,`userId`); keep `Booking_one_confirmed_per_seat`.
- [X] T009 [P] Add models `LE/infra/models/booking-event.model.ts`, `LE/infra/models/launch-event-history.model.ts`; extend `launch-event.model.ts` with the new columns; register the new tables in `packages/backend/db/ownership.ts` for `launch-events` and in the model registry (`pnpm check:model-registry`).
- [X] T010 [P] Write failing unit spec `LE/domain/event-state.spec.ts` (AS-56, `it.each`): every allowed pair (`SCHEDULED→ON_SALE`, `ON_SALE→SOLD_OUT`, `SCHEDULED|ON_SALE|SOLD_OUT→CLOSED`); all other pairs rejected with their code; `assertNever` exhaustiveness.
- [X] T011 [P] Write failing unit spec `LE/domain/hold-state.spec.ts` (AS-56, AS-37, `it.each`): `HELD→CONFIRMING→CONFIRMED`, `HELD→RELEASED`, `HELD→EXPIRED` allowed; every other pair rejected with `HOLD_EXPIRED`/`HOLD_RELEASED`/`HOLD_ALREADY_CONFIRMED`.
- [X] T012 Implement `LE/domain/event-state.ts` and `LE/domain/hold-state.ts` (pure, `assertNever`) to pass T010/T011.
- [X] T013 [P] Write failing unit spec `LE/domain/seat-bitmap.spec.ts` (AS-45): bit order, `ceil(n/8)` length, set/clear round trip and position-of-seat with `fast-check`.
- [X] T014 Implement `LE/domain/seat-bitmap.ts` (pure) to pass T013.
- [X] T015 [P] Write failing unit spec `LE/domain/queue-score.spec.ts` (AS-03, G-01): pre-sale scores within `[open, open+1s)` for any join instant, post-open `max(now, open+1 s)`, ordering table with a seeded random source.
- [X] T016 Implement `LE/domain/queue-score.ts` (inputs `now` and a random source; no `Date.now`/`Math.random`) to pass T015.
- [X] T017 [P] Write failing unit spec `LE/domain/token-bucket.spec.ts` (AS-04, G-02): refill, one-second capacity, no catch-up after downtime, rate change (`it.each`); `fast-check`: never exceeds `N` per one-second window.
- [X] T018 Implement `LE/domain/token-bucket.ts` (pure) to pass T017.
- [X] T019 Define ports in `LE/domain/ports.ts` (injection tokens + interfaces): `EventRepository`, `BookingRepository`, `HoldLedger`, `SeatLockStore`, `QueueStore`, `SeatMapStore`, `QuotaStore`, `HumanVerifier`, `AdmissionTokenPort` (G-36, D-6). Application code uses tokens only; no `@InjectModel`, `DynamoService`, `RedisService` in `application/`.
- [X] T020 [P] Add schema-validated config (S54 config toolkit) in `LE/launch-events.config.ts` (G-43): queue maximum (default 2,000,000, validated at startup) and bot-check provider; TTLs (hold 10 min, token 10 min, heartbeat 120 s, reconcile 60 s with 120 s grace) stay constants in `LE/domain/constants.ts`.
- [X] T021 [P] Declare rate-limit policies in `LE/rate-limit-policies.ts` via `definePolicies`: `launch.queue.join.user` 10/min fail open, `launch.hold.user` 30/min fail closed, `launch.seatmap.ip` 600/min fail open (S50 follow-up for G-35; stop using `search.query`).
- [X] T022 [P] Test support `LE/testing/launch-events-test-kit.ts`: fixtures, switchable store wrappers (fault injection at the system edge: queue store, lock store, ledger, outbox, limiter, map store, human verifier), frozen/advanceable `Clock`, store-access spy, log-capture helper. Shops/users/memberships only via shared fixtures and tenancy/identity exported services (no `ShopModel`/`UserModel` injection, D-7).
- [X] T023 Adapters `LE/infra/`: `sequelize-event.repository.ts`, `sequelize-booking.repository.ts` (conditional `UPDATE … WHERE status = :from` asserting one row) and `dynamo-hold.ledger.ts` (hold item `{holdId, eventId, userId, seats[], state, expiresAtMs, createdAtMs, confirmedAtMs?}`, seat item `{eventId, seat, holdId, fence, expiresAtMs, state}`; every write conditional on hold ID + fence; hold records kept after release), bound in `launch-events.module.ts`.
- [X] T024 Adapters `LE/infra/redis/`: `redis-queue.store.ts`, `redis-seat-map.store.ts`, `redis-quota.store.ts`, `redis-seat-lock.store.ts` plus Lua scripts (atomic join, compare-and-extend lease with epoch, quota claim/credit, seat-map set+seq). Every key expires (data-model.md Redis section).
- [X] T025 Adapters `LE/infra/human-verifier.adapter.ts` (2 s timeout, fail closed, one-time result) and `LE/infra/admission-token.adapter.ts` (`AdmissionTokenPort`: S01 `PurposeTokenService` if exported, else `AccessTokenSigner`/JWKS contract; never `KeyStore`; ES256 pinned, `iss: marketplace`, `aud: admission:<eventId>`, `sub`, `jti` = ticket, purpose `admission`, `exp − iat = 600`; delete the `KeyStore` import, G-03).
- [X] T026 Outbox helper `LE/application/launch-event-outbox.ts` over S53 `OutboxService`: aggregate type `launch_events` (topic `launch_events.events`), envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; the four event types; no alias for `booking_confirmed`.

**Checkpoint**: contracts, migrations, pure domain, ports and adapters in place; `tsc --noEmit` passes.

## Phase 3: User Story 1 — Fair waiting room at a controlled rate (P1) 🎯 MVP

**Goal**: buyers join once, are ordered fairly, admitted at exactly the configured rate by one fenced admitter, and receive a purpose-scoped token.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-queue.e2e-spec.ts`.

- [X] T027 [US1] Write failing `LE/launch-events-queue.e2e-spec.ts` (describe "Launch events: waiting room, admission rate and load shedding"; real `LaunchEventsModule`, worker and topics modules, Postgres/Redis/Dynamo Local, frozen clock) with one `it` per scenario AS-01 … AS-14 exactly as in test-plan.md (concurrency × 20: AS-02, AS-08; Gate 9 fault tests: AS-11, AS-12, AS-14).
- [X] T028 [US1] `LE/application/waiting-room.service.ts` join: atomic per (event,user) (G-07, `201` new / `200` existing), status gate `EVENT_CLOSED`/`EVENT_SOLD_OUT` (G-12), queue-score (G-01), maximum length → `503 WAITING_ROOM_FULL` + `Retry-After: 5` and store down → `503 WAITING_ROOM_UNAVAILABLE` touching no other store (G-09), human check before enqueue when `humanCheckRequired` (G-11).
- [X] T029 [US1] `waiting-room.service.ts` status: owner-only (`404 TICKET_NOT_FOUND` identical for other user, unknown, other event; G-08); return `position` (±16, never increases after open), `queueLength`, `etaSeconds = ceil(position ÷ rate)`, `heartbeatSeconds`, `expiresAt`, `admitted`, `admissionToken`, `tokenExpiresAt` (G-04); polls refresh the 120 s heartbeat, lapse → removal at admission and `404` afterwards (G-05).
- [X] T030 [US1] Replace `LE/infra/admission-ticker.service.ts` with `LE/infra/admitter.ts` in the worker module (G-06): Lua lease with epoch, every admission write conditional on epoch, injected clock, `min(N, waiting)` per second from the token bucket (G-02), rotating start shard, abandoned tickets skipped without consuming capacity, token via `AdmissionTokenPort`, one `admitted` push to `queue:<ticket>`, metric `launch_admission_stale_leader_total`; expiry-job handler removed from this file (moved in T040); redacting logger (G-40); stops first on shutdown.
- [X] T031 [US1] `LE/api/waiting-room.controller.ts`: `POST /launch-events/:eventId/queue` (`launch.queue.join.user`, optional `X-Human-Check`, `Location`; G-10) and `GET …/queue/:ticket`; one service call per method; validated params (`400` on malformed IDs); responses through `queueStatusSchema`.
- [X] T032 [US1] `LE/realtime-topics.module.ts` + `LE/api/realtime-topics.ts` (G-08, G-42): `LaunchEventTopicsModule` registers `queue:<ticket>` via `TopicRegistry.define` with an async owner policy asking the ticket store (unknown ticket refused identically) and `event:<eventId>:seatmap` public, one rule per route (S51 follow-up).
- [X] T033 [US1] Run the queue e2e until green (whole file, then `-t "AS-nn"` per failure).

## Phase 4: User Story 2 — Admitted buyer holds seats; exactly one wins each seat (P1)

**Goal**: token-gated, idempotent, fenced, all-or-nothing holds with ticket limits and defined degradation.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-holds.e2e-spec.ts`.

- [X] T034 [US2] Write failing `LE/launch-events-holds.e2e-spec.ts` (describe "Launch events: admission token, seat holds and ticket limits") with one `it` per AS-15 … AS-32 (concurrency × 20: AS-16, AS-17, AS-22, AS-23, AS-25, AS-26; Gate 9: AS-24, AS-29, AS-30, AS-31; AS-18 builds forged tokens on purpose with a store-access spy at zero and scans logs for tokens).
- [X] T035 [US2] `LE/application/hold.service.ts` (replaces the hold path of `seat-hold.service.ts`): check order auth → body → admission token (zero store access) → event status (cached page for display only, decision from the authoritative gate; G-14) → seats → quota → ledger (G-13); injected clock; `UNKNOWN_SEAT`/`SEATS_NOT_SELECTABLE` 422; duplicate seats collapsed.
- [X] T036 [US2] Fencing and all-or-nothing in `hold.service.ts` and `dynamo-hold.ledger.ts` (G-15, G-21): per-seat fence incremented on every new hold; conditional writes on hold ID + fence; per-seat `SET NX PX` stays a first filter (research D-3); rollback failures logged and counted, never swallowed, repaired by the reconciler; late rollback after a re-hold leaves the new holder intact (AS-17, AS-27).
- [X] T037 [US2] Quota (G-17) in `redis-quota.store.ts`/`hold.service.ts`: atomic claim after validation, expiry tied to the event, credit only on the winning `HELD → RELEASED|EXPIRED` transition, rebuild from bookings + active holds when missing, `422 TICKET_LIMIT_EXCEEDED {limit, remaining}`; expose a limit re-check for T045.
- [X] T038 [US2] Best-available / general admission (G-16): `quantity` mode, `seatingMode`, disjoint non-blocking assignment, adjacency preference, `NO_SEATS_AVAILABLE`, no partial hold, no lock waiting.
- [X] T039 [US2] Degradation (G-20): lock store failure → continue on the ledger and count degradation; ledger failure → rollback + `503 HOLDS_UNAVAILABLE` + `Retry-After: 2` with no residue; limiter failure on `launch.hold.user` → `503 HOLDS_UNAVAILABLE` (fail closed).
- [X] T040 [US2] Release and expiry (G-19, G-24, G-27): `LE/application/release.service.ts` with conditional `HELD → RELEASED|EXPIRED` first, effects (ledger seats, quota, bit, delta) only for the winner; repeated release `204`; cross-user `404 HOLD_NOT_FOUND`; hold records kept. Job `LE/infra/jobs/expire-hold.job.ts` (`launch-events.expire-hold`, `runAt = expiresAt`, idempotent, invalid payload rejected with no effect); a late job after another hold took the seat changes nothing.
- [X] T041 [US2] `LE/api/holds.controller.ts`: `POST /launch-events/:eventId/holds` (`X-Admission-Token`, `Idempotency-Key` through the S54 idempotency facility with per-user scope, `launch.hold.user`; G-18) and `DELETE /launch-holds/:holdId` (`204`); `holdSeatsRequestSchema`/`holdSchema`; one call per method; no token logic in the controller.
- [X] T042 [US2] Run the holds e2e until green (narrowest `-t "AS-nn"` first).

## Phase 5: User Story 3 — A hold becomes a booking exactly once (P1)

**Goal**: sealed ledger → single DB transaction (bookings, history, outbox; no network call inside) → finalise; idempotent; reconciled.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-confirm.e2e-spec.ts`.

- [X] T043 [US3] Write failing `LE/launch-events-confirm.e2e-spec.ts` (describe "Launch events: booking confirmation, idempotency and recovery") with one `it` per AS-33 … AS-44 (concurrency × 20: AS-35, AS-36, AS-38, AS-43; Gate 9: AS-41, AS-42; assert no Dynamo/Redis call recorded inside the DB transaction; duplicate-confirmed-seat query returns 0 rows after the run).
- [X] T044 [US3] `LE/application/confirm.service.ts` (G-23, G-24, G-26): seal ledger `HELD→CONFIRMING` (conditional; excludes expiry and takeover) → one `TransactionRunner.run` (S54; no new `sequelize.transaction`) inserting `Booking`, `BookingEvent` and outbox rows → finalise ledger `CONFIRMED` (seats no longer expire) and publish `booked` delta; closed event → `409 EVENT_CLOSED`; natural re-confirm `200` with the same booking IDs; unique-index conflict → whole transaction rolled back → `409 SEAT_TAKEN {seat}`; codes `HOLD_EXPIRED`/`HOLD_RELEASED`/`HOLD_ALREADY_CONFIRMED`.
- [X] T045 [US3] In the same transaction: authoritative ticket-limit re-check (`TICKET_LIMIT_EXCEEDED`, G-17) and sold-out transition (G-28): conditional `ON_SALE→SOLD_OUT`, one `LaunchEventHistory` row, one `launch_events.event_sold_out` outbox row, event cache invalidated, next hold `409 EVENT_SOLD_OUT`.
- [X] T046 [US3] Voucher (G-29): outbox row routed to SQS command `orders.booking_voucher_requested` v1 `{holdId, bookingIds, launchEventId, shopId, userId, seatCount}`, dedupe key `booking-voucher:<holdId>`; best-effort, booking never waits; if the queue is not yet in `elasticmq.conf`, define it there (L-002, L-020).
- [X] T047 [US3] Confirm route in `LE/api/holds.controller.ts` (G-25, G-27): `POST /launch-holds/:holdId/confirm` through the S54 idempotency facility (`201` first, `200` repeat with `Idempotent-Replayed`, `409 idempotency_in_flight`, `422` reuse/missing/invalid, `5xx` releases the key); non-UUID `400`; unknown or other user's hold `404 HOLD_NOT_FOUND`; no admission token required.
- [X] T048 [US3] Events (G-31): `booking_confirmed`, `event_sold_out`, `event_closed` emitted through T026 in the owning transaction (`event_created` in T056); none when the transaction rolls back (AS-42 refused append → generic `500`, hold still `HELD`).
- [X] T049 [US3] Reconciler `LE/infra/jobs/reconcile-seats.job.ts` (`launch-events.reconcile-seats`, every 60 s, concurrency 1, `DistributedLock` single flight with fence; S52 follow-up): repairs booking-without-ledger and ledger-without-booking older than 120 s, clears stray map bits with a `released` delta, expires holds of closed events within 60 s, double-booking detector (`launch_double_booking_detected_total`), `launch_reconcile_repairs_total`; two workers repair each drift once.
- [X] T050 [US3] Run the confirm e2e until green.

## Phase 6: User Story 4 — Cheap, ordered seat map (P2)

**Goal**: sequenced, rebuildable, rate-limited public seat map and event page.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-seatmap.e2e-spec.ts` plus the reducer spec (T005/T006).

- [X] T051 [US4] Write failing `LE/launch-events-seatmap.e2e-spec.ts` (describe "Launch events: seat map, deltas and realtime topics") with one `it` per AS-45 … AS-50 (concurrency × 20: AS-46; Gate 9: AS-48 wiped store, AS-49 limiter down; AS-50 anonymous vs non-owner topic subscription, `admitted` reaches only the owner).
- [X] T052 [US4] `LE/application/seat-map.service.ts` + `redis-seat-map.store.ts` (G-32, G-33): `seq` assigned atomically with the bits in one script; delta `{seq, change, seats[]}` published through `RealtimePublisher` (errors counted, not swallowed); `seatMapSchema` with `seatCount`, `seatsPerRow`, `seq`; expiry on every key; rebuild from bookings + active holds behind a single flight (`DistributedLock`); the map is never consulted for hold or confirm decisions.
- [X] T053 [US4] `LE/api/seat-map.controller.ts` (G-34): `GET /launch-events/:eventId` (anonymous, `s-maxage=60`, public fields only via contracts, unknown `404` negative-cached 5 s, invalidated on every status change) and `GET …/seatmap` (`s-maxage=1`, `launch.seatmap.ip`, limiter down still `200`); no `skipThrottle`.
- [X] T054 [US4] Run the seat map e2e until green.

## Phase 7: User Story 5 — Shop staff create, watch and close an event (P2)

**Goal**: organizer routes, status machine driven by jobs, my-bookings.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-organizer.e2e-spec.ts`.

- [X] T055 [US5] Write failing `LE/launch-events-organizer.e2e-spec.ts` (describe "Launch events: organizer routes, status machine and my bookings") with one `it` per AS-51 … AS-57 (concurrency × 20: AS-54 two concurrent closes → one `200`; AS-53 130 bookings in pages 50/50/30; AS-52 every `400`/`422 invalid_schedule`/`401`/`403`/`404` class).
- [X] T056 [US5] `LE/application/launch-event.service.ts` `create` (G-35): validation (`startsAt`/`salesOpenAt` cross-validated, `invalid_schedule`; defaults in the domain: `perUserLimit` default 2 range 1–10, `seatCount` 1–100000, `seatingMode` default `SEATED`, `humanCheckRequired` default false), `launchEventSchema` response (no model returned), `event_created` outbox row, enqueue `launch-events.open-sales` (`runAt = salesOpenAt`) and `launch-events.close-event` (`runAt = startsAt`).
- [X] T057 [US5] Status machine (G-22): `LaunchEventService.close` (conditional update to `CLOSED`, `closedReason`, `LaunchEventHistory` row, one `event_closed`, queue cleared, cache invalidated, repeat `409 EVENT_ALREADY_CLOSED`); jobs `LE/infra/jobs/open-sales.job.ts` and `LE/infra/jobs/close-event.job.ts` (idempotent, single-run, invalid payload rejected; closed/sold-out events untouched; holds expired ≤ 60 s).
- [X] T058 [US5] `LE/api/organizer.controller.ts`: `POST /shops/:shopId/launch-events` (`ShopScoped('products.write')`, `201` + `Location`), `POST …/:eventId/close` (`products.write`), `GET …/:eventId/bookings?limit&cursor` (`orders.manage`; `limit` ≤ 100 default 50, opaque cursor, order `confirmedAt DESC, bookingId DESC`, shop in the predicate; G-30, FR-045); one call per method; other shop's event `404` identical to unknown.
- [X] T059 [US5] `LE/application/booking-query.service.ts`: organizer keyset page and `GET /launch-events/:eventId/my-bookings` (principal-scoped, newest first, unknown event `404`, `401`) routed in `LE/api/buyer.controller.ts` (G-30).
- [X] T060 [US5] Run the organizer e2e until green.

## Phase 8: User Story 6 — Operators can trust and observe the system (P3)

**Goal**: metrics, redaction, problem contract, job idempotency, domain isolation, events.
**Independent test**: `test-spec.sh libs/domains/launch-events/launch-events-operations.e2e-spec.ts`.

- [X] T061 [US6] Write failing `LE/launch-events-operations.e2e-spec.ts` (describe "Launch events: jobs, events, metrics and domain isolation") with one `it` per AS-58 … AS-62, including duplicate-delivery, concurrent-delivery and invalid-payload tests of each of the four jobs (VII.4); statement-log check that every query's tables ⊆ `owned(launch-events)`; no FK to `Shop` in the migrated schema; barrel export list equals the three modules + types; each emitted event parses with its contracts schema.
- [X] T062 [US6] Metrics and redaction (G-40, AS-58, SC-010): `launch_*` metrics with bounded labels (no event/user IDs on counters; queue-length gauge for `ON_SALE` events only), hold-degradation and limiter-failure counters, `requestId` on log lines; tokens, tickets and idempotency keys never reach logs, spans, metric labels, problem bodies or events.
- [X] T063 [US6] Barrel and module trim (G-38, D-7, D-8): `LE/index.ts` exports `LaunchEventsModule`, `LaunchEventsWorkerModule`, `LaunchEventTopicsModule` and DTO/event types only (S23 exports left alone); `launch-events.module.ts` stops exporting `WaitingRoomService`/`SeatHoldService`; worker module registers the admitter and the four jobs.
- [X] T064 [US6] Delete `LE/application/seat-hold.service.ts`, `LE/api/launch-events.controller.ts`, `LE/api/launch-events.dto.ts` and the old `LE/launch-events.e2e-spec.ts` (G-36, G-41) once their behaviour lives in the new services; leave S23 files untouched; confirm no direct `sequelize.transaction` and no foreign model injection remain in S22 files.
- [X] T065 [US6] Update `scripts/load-tests/launch-event.test.js` (G-44): idempotency keys, `X-Admission-Token`, `201`/`200` join, new codes and routes; thresholds unchanged (SC-004/SC-009 stay "not run" ops artifacts).
- [X] T066 [US6] Run the operations e2e until green.

## Phase 9: Polish and cross-cutting

- [X] T067 Update `docs/spec/capabilities/S22-launch-event-booking.md` to final behaviour; keep every `[proof:]`/`[code:]` true; run `python3 scripts/livespec/check.py`.
- [X] T068 [P] Update `docs/work/architecture/domain-map.md` ("Emits" for `launch-events`: the four `launch_events.*` events) and the S22 row of `docs/work/architecture/pattern-map.md` if statuses change.
- [X] T069 [P] Under "## Sibling-spec follow-ups" in gaps.md keep the S01, S10, S28, S50, J03 bullets and add any new contract names introduced during build; confirm S28's topic `launch_events.events` and the payload names consumed by S04/S15/S17/S20/S21/S25 against `packages/contracts`. Do not edit sibling specs.
- [X] T070 [P] Check that the "Ops artifacts" section of quickstart.md and the two S22 rows in `specs/UNVERIFIED.md` (SC-004, SC-009) remain accurate and say "not run".
- [X] T071 Static gates: `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (compare with T001); `pnpm check:module-graph`; `pnpm check:model-registry`.
- [X] T072 Run the whole capability once: `test-spec.sh libs/domains/launch-events` (six e2e files plus unit specs) and the contracts reducer spec; the duplicate-confirmed-seat query returns 0 rows.

## Gap coverage

G-01 T015/T016/T028 · G-02 T017/T018/T030 · G-03 T025/T030 · G-04 T029 · G-05 T029 · G-06 T030 · G-07 T028 · G-08 T029/T032 · G-09 T028 · G-10 T031 · G-11 T025/T028 · G-12 T028 · G-13 T035 · G-14 T035 · G-15 T036 · G-16 T038 · G-17 T037/T045 · G-18 T041 · G-19 T040 · G-20 T039 · G-21 T036 · G-22 T057 · G-23 T044 · G-24 T011/T012/T040/T044 · G-25 T047 · G-26 T044 · G-27 T040/T047 · G-28 T045 · G-29 T046 · G-30 T058/T059 · G-31 T048/T056 · G-32 T052 · G-33 T049/T052 · G-34 T053 · G-35 T056 · G-36 T019/T023/T024/T064 · G-37 T007 · G-38 T063 · G-39 T003 · G-40 T030/T062 · G-41 T027/T034/T043/T051/T055/T061/T064 · G-42 T032 · G-43 T020 · G-44 T065 · D-6 T019 · D-7/D-8 T063 · IX.4 FK T007. Follow-ups: S28 T026/T069, S50 T021, S51 T032, S52 T049/T052.

## Dependencies and order

- Phase 1 → Phase 2 (T004–T026) → stories. US1 → US2 → US3 are sequential (admission token → hold → confirm). US4 and US5 need only Phase 2 plus the map hook from T036/T052; US6 last. The event-status gate is used by US1/US2, so its conditional transition lives in T023 (adapter) and T012 (pure rules).
- Within a story the e2e test task precedes the code tasks; unit-spec tasks precede their implementation.
- Parallel: T003–T005, T007–T011, T013, T015, T017, T020–T022; T068–T070.

## Implementation strategy

MVP = Phase 2 + US1 (waiting room). US2 and US3 deliver the booking invariant (SC-001/002/005); US4/US5 add the map and organizer surface; US6 closes isolation and observability. Run the narrowest `-t "AS-nn"` per task and the whole capability suite once at the end.
