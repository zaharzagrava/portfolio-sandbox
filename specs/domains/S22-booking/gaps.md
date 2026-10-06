# Gaps: S22 — Launch-Event Booking (domain `launch-events`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's `check:table-ownership` lines. This is the implementation agent's to-do list. All paths are under `packages/backend/libs/domains/launch-events/` unless stated; line numbers are from the draft at the time of writing. The code is an imperfect draft; the spec wins.

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Waiting room (`application/waiting-room.service.ts`, `infra/admission-ticker.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | AS-03, FR-003 | `:52` pre-sale score `salesOpenAt + Math.random()*1000` but post-open score is `now`, which can land inside that second and overtake pre-sale joiners; `Math.random` and `Date.now()` in application code. | Pure `domain/queue-score.ts` taking `now` and a random source; post-open score `max(now, open+1 s)`. |
| G-02 | AS-04, FR-004 | `:75-83` admits `ceil(N/8)` per shard → up to `N+7` per tick; abandoned tickets (`:82`) still count; the e2e asserts `≥ 10`. No bucket, no catch-up cap. | Exactly `min(N, waiting)`; rotating start shard for the remainder; one-second bucket in pure `domain/token-bucket.ts`; abandoned tickets skipped without consuming capacity. |
| G-03 | AS-05, FR-006 | `:84-87` signs through identity's `KeyStore` (not an exported contract); token carries no `jti`, no expiry field in the status; verification takes the algorithm from the key set and does not isolate purpose from access tokens (`:101-117`); `iss` string literal. | Use S01's `PurposeTokenService` (R1, [CONTRACT]); claims per FR-006; status returns `tokenExpiresAt`; pinned algorithm; delete the `KeyStore` import. |
| G-04 | AS-06, FR-009 | Position is `rank × 8 + 1`; no ETA, no `queueLength`, no heartbeat or expiry fields (`:62-70`). | Return `position`, `queueLength`, `etaSeconds`, `heartbeatSeconds`, `expiresAt`; keep the ±16 bound; never increase after open. |
| G-05 | AS-07, FR-007 | Tickets live 1 h (`:10`) irrespective of activity; no heartbeat. | 120 s heartbeat refreshed by status polls; lapse → removal at admission; `404 TICKET_NOT_FOUND` afterwards. |
| G-06 | AS-08, FR-005 | `admission-ticker.service.ts:41-44` leader election: `SET NX PX`, then an unconditional `PEXPIRE` by whoever read the owner key; no fencing; `Date.now()` at `:52`; the tick loops events sequentially. | Lua compare-and-extend lease with a monotonically increasing epoch; every admission write conditional on the current epoch; injected clock; metric `launch_admission_stale_leader_total`. |
| G-07 | AS-02, FR-002 | `join` does check-then-write (`:47-50`): two concurrent joins by one buyer can create two tickets. | One atomic script keyed by (event, user) creating or returning the ticket; `201` vs `200`. |
| G-08 | AS-10, FR-008 | `status` returns any ticket's state with no ownership check (`api/launch-events.controller.ts:47-50`); topic `queue:` policy `() => true` (`api/realtime-topics.ts:13`). | Owner check in the query path (`404` otherwise); owner-only topic policy ([CONTRACT] S51 async principal policy). |
| G-09 | AS-11, FR-010 | No maximum queue length, no shedding, no defined behaviour when Redis is down. | Config-validated maximum; `503 WAITING_ROOM_FULL` / `WAITING_ROOM_UNAVAILABLE` with `Retry-After` and no other store touched. |
| G-10 | AS-12, FR-011 | Uses `RateLimit('search.query')` (`:38`). | Policy `launch.queue.join.user` (S50). |
| G-11 | AS-13, AS-14, FR-012 | No bot-check hook. | `HumanVerifier` port in `domain/`, adapter in `infra/` with 2 s timeout, fail closed, one-time result; event flag `humanCheckRequired`. |
| G-12 | AS-09 | Join does not check event status (closed, sold out) (`:41-45`). | Status gate with `EVENT_CLOSED` / `EVENT_SOLD_OUT`. |

### Holds (`application/seat-hold.service.ts`, `api/launch-events.controller.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-13 | AS-15, FR-014 | Quota is claimed (`:57`) before event status, token-independent validation of seats and rollback paths; seat range check at `:55` throws a free-text 422; no event-status gate; `Date.now()` at `:59`, `:89`, `:153`. | Order of checks per spec (auth → body → token → event status → seats → quota → seats); injected clock; coded errors (FR-051). |
| G-14 | AS-18, FR-013 | Token check is in the controller (`:61-68`) and runs, then the event is loaded from the database by primary key (`:69`) — no cache, one database read per hold on the hot path. | Verify first with zero store access; read the event through the cache but decide status from the authoritative state held with the hold ledger/Redis gate. |
| G-15 | AS-16, AS-17, FR-017, FR-018 | Multi-seat loop is sequential Redis `SET NX` then a Dynamo put per seat (`:60-67`); rollback uses compare-and-delete on Redis but a Dynamo delete conditional only on `holdId` (`:163-172`), swallowing every error with `.catch(() => undefined)` — a failed rollback leaves a ghost lock silently. | Seat records carry a fencing number; conditional writes on hold ID + fence; rollback failures logged and counted, repaired by the reconciler. |
| G-16 | AS-26, FR-020 | No best-available / general-admission path; the DTO accepts `seats` only (`api/launch-events.dto.ts:16-22`). | `quantity` mode, `seatingMode`, `SEATS_NOT_SELECTABLE`, disjoint non-blocking assignment, adjacency preference, `NO_SEATS_AVAILABLE`. |
| G-17 | AS-21 – AS-24, FR-026 – FR-028 | Redis counter is the only enforcement, `INCRBY` then `EXPIRE` (non-atomic, `:180-181`), 30-day expiry, free-text 422; decrement on every release/rollback (`:70,135`) without proof the hold transition won; counter loss silently lifts the limit; no limit check at confirm. | Atomic claim script; credit only on the winning `HELD → RELEASED|EXPIRED` transition; rebuild from bookings + active holds; authoritative re-check in the confirm transaction; `TICKET_LIMIT_EXCEEDED {limit, remaining}`. |
| G-18 | AS-25, FR-021 | No `Idempotency-Key` on hold (`:61-71`). | Shared idempotency facility (S54), per-user scope, V.6 semantics. |
| G-19 | AS-28, FR-024 | `release` for expiry (`:127-138`) is read-then-act: reads the hold, rolls back, deletes the hold, decrements — two runs (job + user) interleave and double-credit; the expiry job lives in `infra/admission-ticker.service.ts:58-61` next to the admitter. | Conditional `HELD → EXPIRED` update first; effects after only for the winner; job handler moved to its own `infra/` class. |
| G-20 | AS-29 – AS-31, FR-022, FR-023 | No defined behaviour when Redis or Dynamo fail: a Redis error aborts the hold with a 500; a Dynamo failure after Redis `SET` can leave a lock for 10 minutes. | Redis failure → continue on the ledger and count degradation; ledger failure → `503 HOLDS_UNAVAILABLE`, rollback; policy `launch.hold.user` fail closed. |
| G-21 | AS-27, FR-019 | No fencing numbers; stale holder protection relies on `holdId` equality only. | Per-seat fence incremented with each new hold; every write conditional on it. |
| G-22 | AS-20, FR-015, FR-043 | `LaunchEvent.status` never changes (`infra/models/launch-event.model.ts`); no open-sales, sold-out or close logic; no close route. | Status machine, jobs `launch-events.open-sales` / `close-event`, close route, history rows, cache invalidation. |

### Confirm, bookings, events

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-23 | AS-33, AS-41, AS-42, FR-029 | `confirm` (`:85-125`) inserts bookings (`bulkCreate`, no transaction opened by the application layer, `:93`) then performs Dynamo updates and Redis `persist` per seat in a loop; any failure after the insert leaves the ledger, lock and map inconsistent; no outbox, no history table, no voucher command. | Seal ledger → one transaction (bookings, `BookingEvent` rows, outbox rows) with no network call inside → finalise ledger/map; reconciler repairs. Add `BookingEvent` migration (expand). |
| G-24 | AS-36, AS-37, FR-032, FR-033 | Confirm compares `Date.now()` with the stored expiry (`:89`) and has no exclusion against the expiry job or takeover; `confirm` of a released hold answers `404` (hold deleted at `:134`) instead of `409 HOLD_RELEASED`; `release` of a confirmed hold returns `false` with `200` (`:130`). | Hold state machine with conditional updates (`domain/hold-state.ts`), codes `HOLD_EXPIRED`, `HOLD_RELEASED`, `HOLD_ALREADY_CONFIRMED`. Keep hold records (state), do not delete at release. |
| G-25 | AS-34, AS-35, FR-030 | No `Idempotency-Key`; replay relies on `UniqueConstraintError` handling (`:98-103`) which returns existing rows only when counts match. | Shared idempotency facility; natural re-confirm `200`. |
| G-26 | AS-38, FR-031 | Partial unique index exists (migration `Booking_one_confirmed_per_seat`) — correct, keep. The mapping of a violation to `SEAT_TAKEN` exists (`:102`) but also swallows partial multi-seat conflicts without verifying nothing was written (`bulkCreate` is not in a transaction). | Single transaction; conflict → rollback → `409 SEAT_TAKEN {seat}`. |
| G-27 | AS-39, FR-045 | Cross-user confirm → `404` (`:87`), release → `403` (`:131`). | `404 HOLD_NOT_FOUND` for both. |
| G-28 | AS-43, FR-034 | No `SOLD_OUT` transition. | Conditional update in the confirm transaction; `event_sold_out` once. |
| G-29 | AS-44, FR-035 | No voucher command. | Outbox row → SQS command `orders.booking_voucher_requested`. |
| G-30 | AS-57, AS-53, FR-037, FR-042 | No `my-bookings` route, no organizer bookings list. | Add both with keyset pagination (organizer) and principal-scoped predicates. |
| G-31 | AS-62, FR-046 | No events emitted by booking. | Four events through the outbox with the envelope. |

### Seat map

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-32 | AS-45, AS-46, FR-038, FR-039 | `seatMap` returns only the bitmap (`:140-143`); no `seatCount`, `seatsPerRow`, `seq`; `markSeats` (`:191-198`) sets bits in a pipeline then publishes a delta with no sequence, and swallows publish errors. | `seq` assigned atomically with the bits (one script); schema `seatMapSchema`; delta schema with `seq`. |
| G-33 | AS-48, FR-040 | The bitmap key has no TTL and cannot be rebuilt; a Redis flush shows an empty room until holds happen again; no reconciler. | Expiry on every key; rebuild from bookings + active holds behind a single flight; reconciler `launch-events.reconcile-seats`. |
| G-34 | AS-49 | `skipThrottle: true` on both public reads (`api/launch-events.controller.ts:30,53`); event page returns the raw row including `createdAt`, `updatedAt`, `admissionRatePerSec` (`:87`). | Policy `launch.seatmap.ip`; public DTO via contracts. |

### Events, API shape, boundaries

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-35 | AS-51, AS-52, FR-041 | Controller injects the model and creates the row directly (`:17,25-26`) — business logic and data access in an `api/` class (II.1, I.2); returns the model (V.1); no date rules; `startsAt`/`salesOpenAt` not cross-validated; defaults live in the DTO. | Application service `LaunchEventService.create`, response DTO, validation rules and `invalid_schedule`, defaults in the domain. |
| G-36 | AS-61 | `launch-events.controller.ts:3,17` and `admission-ticker.service.ts:29` inject `@InjectModel(LaunchEvent)` in `api/` and `infra/` consumers; `SeatHoldService` injects `Booking` model directly from `application/` (`:50`); I.2 requires ports in `domain/` and repositories in `infra/`. | Repository ports (`EventRepository`, `BookingRepository`, `HoldLedger`, `SeatLockStore`, `QueueStore`, `SeatMapStore`, `QuotaStore`, `HumanVerifier`), adapters in `infra/`, `application/` uses tokens only (debt D-6). |
| G-37 | AS-61, FR-041 | Migration `20261001170000-launch-events.js:17` declares `REFERENCES "Shop"("id")` (cross-owner FK). | Expand/contract migration dropping the FK with `lock_timeout`; keep `shopId UUID NOT NULL`. |
| G-38 | AS-61 | `index.ts:7-8` exports `BookingModel`, `LaunchEventModel`; `launch-events.module.ts:16` exports `WaitingRoomService`, `SeatHoldService`. | Barrel exports `LaunchEventsModule`, `LaunchEventsWorkerModule`, `LaunchEventTopicsModule` and DTO/event types only (S23's exports are S23's to trim). |
| G-39 | AS-59 | Errors are Nest exceptions with free-text messages; only `SEAT_TAKEN` and `HOLD_EXPIRED` carry a `code` (`:64,89`). | Domain errors mapped by the global filter to the FR-051 codes. |
| G-40 | AS-58 | No metrics; logger warnings include `e.message` (`admission-ticker.service.ts:36`). | Metrics of AS-58; redacting logger. |
| G-41 | VII | `launch-events.e2e-spec.ts` (119 lines): calls `SeatHoldService`/`WaitingRoomService` directly, boots only `LaunchEventsModule`, uses `UserModel`/`ShopModel` injection (`:9,10,42-46`) and `UserModel.bulkCreate` for users; asserts `≥ 10` admitted; only one HTTP test (403). Real DynamoDB is used (good). | Replace with the six HTTP e2e files in `test-plan.md`; fixtures instead of model injection; delete the service-level calls; keep Dynamo Local. |
| G-42 | AS-50, FR-050 | `api/realtime-topics.ts` defines `queue:` public (see G-08). | Owner-only policy. |
| G-43 | Config | Queue shard count, hold TTL, token TTL are module constants (`waiting-room.service.ts:8-11`, `seat-hold.service.ts:20`); no validated config for queue maximum, bot-check provider. | Schema-validated config (S54) for the queue maximum and the bot-check provider; TTLs stay constants. |
| G-44 | Load test | `scripts/load-tests/launch-event.test.js` logs in per VU and expects `201` from join and the old routes. | Update to idempotency keys, `X-Admission-Token`, `201`/`200` join, new codes; thresholds unchanged. |

## 2. Open debt-register rows that touch this capability

`docs/architecture/debt-register.md` has no row that names `launch-events` or `S22` by ID. The generic open rows below apply to every capability of every domain, so they apply here:

| Debt | Where in `launch-events` (S22 part) | Mechanism that replaces it |
|---|---|---|
| D-6 (I.2 layering) | G-36: `api/launch-events.controller.ts` injects `LaunchEvent` model and `CacheService`; `application/seat-hold.service.ts` injects `Booking` and uses `infra`-level SDK commands (`DynamoService`, `RedisService`, `JobsService`) directly instead of `domain/` ports. | Repository and store ports in `domain/`, adapters in `infra/`, `@Inject(TOKEN)` in `application/` (not an IX.7 case; layering). |
| D-7 (IX.4 model imports) | S22 imports no other domain's model. It exports its own `BookingModel`/`LaunchEventModel` (G-38) although nobody else imports them. | Drop the model exports (no consumer needs them; a consumer would use R1 or R3). |
| D-8 (X.4 barrel exports internals) | `index.ts` exports models and `Reservoir` (S23). For S22: the services exported from the module (`launch-events.module.ts:16`). | Apps import `LaunchEventsModule`, `LaunchEventsWorkerModule`, `LaunchEventTopicsModule` only. |
| D-12 (IX.4 raw SQL on other domains' tables) | None found in the S22 files. (The only raw SQL in the domain is S23's `application/live.service.ts:54-80` over `LiveStream`, an owned table.) | — |
| Other: IX.4 foreign key | G-37: `LaunchEvent.shopId → "Shop"`. | Plain ID column, no FK. Shop existence is guaranteed at create by tenancy's `ShopScoped` guard (R1). |

## 3. `pnpm --dir packages/backend check:table-ownership` lines for this domain

The command could not be run in the specifying session (the sandbox refused it, no approval available), so the lines below were derived by hand from the same sources the script reads (`forFeature` / `@InjectModel` registrations, associations, raw SQL strings) and **must be re-run by the implementer before starting and after finishing**. Derived findings for `launch-events`:

| Kind | Location | Table | Owner | Replaces with |
|---|---|---|---|---|
| MODEL (S23, not this capability) | `live.module.ts:4,10`, `api/live.controller.ts:7,35` `ShopMembership` | `ShopMembership` | `domain:tenancy` | R1 `ShopAccessService.assertMember` (S03) — S23's to-do |
| SQL | none in S22 files | — | — | — |
| MODEL | none in S22 files (`Booking`, `LaunchEvent` are owned: `db/ownership.ts:116-117`) | — | — | — |
| FK (outside the script's reach, IX.4) | migration `20261001170000-launch-events.js:17` `REFERENCES "Shop"` | `Shop` | `domain:tenancy` | plain ID, no FK (G-37) |

Goal state: zero findings for `launch-events` under `--strict` after S22 and S23 land; S22 adds none.

## 4. Order of work (suggested)

1. Contracts and codes (`packages/contracts` schemas, FR-051 vocabulary), migrations (drop FK, `BookingEvent`, event `humanCheckRequired`, `seatingMode`, `quotas` as needed — expand only).
2. Pure `domain/` modules and their unit specs: `queue-score`, `token-bucket`, `event-state`, `hold-state`, `seat-bitmap`, the contracts reducer.
3. Ports and adapters; Lua scripts for join, lease/fencing, quota claim, seat-map update.
4. Application services; controllers shrink to one call each.
5. Jobs (`expire-hold`, `open-sales`, `close-event`, `reconcile-seats`) and the admitter; outbox events and the voucher command.
6. Rewrite the e2e specs per `test-plan.md`; update the k6 script.
7. Trim the barrel and module exports; run `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`.
8. Update `docs/architecture/domain-map.md` ("Emits" for `launch-events`) and the S22 row of `docs/architecture/pattern-map.md` if statuses change.
