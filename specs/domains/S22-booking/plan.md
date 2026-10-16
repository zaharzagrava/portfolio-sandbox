# Implementation Plan: S22 — Launch-Event Booking (domain `launch-events`)

**Branch**: `S22-booking` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md) (G-01 … G-44, debt D-6/D-7/D-8, IX.4 FK), [questions.md](questions.md) (defaults accepted).

## Summary

Rebuild the booking half of `launch-events` (the S23 live stream stays untouched) from a service-level draft into a layered, HTTP-first capability: a sharded Redis waiting room with a fenced single admitter, purpose-scoped admission tokens, a durable DynamoDB hold ledger with per-seat fencing numbers, a single-transaction confirm (bookings, `BookingEvent` history and outbox rows, no network call inside), a sequenced 1-bit seat map, an event status machine driven by S49 jobs, and a reconciler. Every state transition is a conditional update asserting one affected row. Redis is only a filter or cache (III.9). The spec wins over the draft.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS (`packages/backend`, `packages/contracts`)
**Primary Dependencies**: Sequelize/Postgres, ioredis (Lua), DynamoDB (`DynamoService`), S49 `JobsService`, S50 rate-limit policies, S51 `TopicRegistry`/`RealtimePublisher`, S52 `CacheService`/`DistributedLock`, S53 `OutboxService`, S54 `TransactionRunner`/`@Transactional`/idempotency/problem filter, `Clock` (`libs/common/core/clock.ts`), S01 identity (`Firewall`, `@User`, purpose token), S03 `ShopScoped`
**Storage**: Postgres `LaunchEvent`, `Booking`, new `BookingEvent`, `LaunchEventHistory`; DynamoDB hold ledger; Redis (queue shards, quota, seat map, locks, lease)
**Testing**: jest e2e through HTTP (six files, run via `/opt/sdd/repo/scripts/sdd/test-spec.sh`), table-driven unit specs for pure `domain/`, `fast-check` for bitmap and token bucket, contracts reducer spec
**Target Platform**: Linux; core API, worker and sse-gateway apps must each boot standalone (L-015, L-018)
**Project Type**: backend domain library plus contracts package
**Performance Goals**: SC-004 (join p99 100 ms, hold 150 ms, seat map 50 ms at 20k concurrent); relational DB sees only confirmations
**Constraints**: no new `sequelize.transaction` (the domain has none today); no network call inside a DB transaction; injected clock and random source (no `Date.now`/`Math.random` in `application/`)
**Scale/Scope**: ≤100k seats per event, queue maximum 2,000,000 (config), 8 shards

No NEEDS CLARIFICATION remain; see [research.md](research.md).

## Constitution Check

| Principle | Verdict | How |
|---|---|---|
| I/II Layering, thin controllers | Pass after work | Ports in `domain/`, adapters in `infra/`, one call per controller method (G-35, G-36, D-6) |
| III Data access, transactions | Pass | Confirm via `TransactionRunner.run`; conditional updates; outbox in the same tx; Redis never the source of truth |
| IV Communication | Pass | Events via outbox; voucher by SQS command to orders; token service as R1 |
| V Contracts, errors | Pass | Schemas in `packages/contracts`, problem+json codes (FR-051), V.6 idempotency, no model returned |
| VII Testing | Pass | HTTP e2e rewrite (G-41), concurrency ×20, Gate 9 fault tests, pure unit specs |
| VIII Operational safety | Pass | Metrics and redaction (AS-58), pinned algorithm, per-policy fail modes |
| IX Isolation | Pass | Drop the `Shop` FK (G-37); no foreign model imports; barrel trimmed (D-7, D-8) |
| X Boundaries | Pass | Barrel exports three modules plus types |

No violations, so Complexity Tracking is empty. Post-design re-check: unchanged (only owned tables and contract schemas are added).

## Dependencies and risks found while planning

- **`PurposeTokenService` (S01 R1) does not exist.** `libs/domains/identity/index.ts` exports `AccessTokenSigner`, `ServiceTokenService`, `KeyStore`, but no purpose-token service. Plan: a domain port `AdmissionTokenPort`; the `infra/` adapter uses `PurposeTokenService` if it has shipped, otherwise only the exported `AccessTokenSigner`/JWKS contract (never `KeyStore`). A sibling follow-up is recorded in gaps.md. AS-18 tests the port, so the swap is local.
- The idempotency facility exists (`libs/infrastructure/idempotency`); use it as is.
- `TopicPolicy` is already async and receives the viewer, so the owner-only `queue:` policy needs no S51 change.
- Rate-limit policies are declared per domain with `definePolicies`; add the three `launch.*` names here (the domain holding the call site declares them, S50 T048) and stop using `search.query`.

## Follow-ups from already-built specs (treated as requirements)

| From | Item | Plan |
|---|---|---|
| S28 | Topic names and payloads in `contracts/events.md` are the consumer's assumption | `packages/contracts` ships `launch_events.*` schemas; AS-62 asserts names. Outbox aggregate type `launch_events` so the topic is `launch_events.events` (research D-6). |
| S28 | `booking_confirmed` consumed under both names | Emit only `launch_events.booking_confirmed`; no alias. |
| S50 | Replace mis-used policies (G-35) | Join uses `launch.queue.join.user` (G-10); seat map `launch.seatmap.ip` (G-34); hold `launch.hold.user`. |
| S51 | Register routes via `TopicRegistry.define`, one rule per route | `LaunchEventTopicsModule`: `queue` (owner policy), `event` with suffix `seatmap` (public) (G-42, FR-050). |
| S52 | May adopt `DistributedLock` with fence for `SET NX PX` at `seat-hold.service.ts:63` | Admitter lease (G-06) and the seat-map rebuild single flight use `DistributedLock`; its fence is the admission epoch. The per-seat lock stays a plain first-filter `SET NX PX` because the ledger is the authority (research D-3). |

## Project Structure

### Documentation

```text
specs/domains/S22-booking/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http.md, events-and-commands.md, realtime-and-jobs.md)
└── tasks.md   # by /speckit-tasks
```

### Source Code

```text
packages/contracts/src/launch-events/   # schemas, error codes, seat-map-reducer (+ spec)
packages/backend/libs/domains/launch-events/
├── domain/       # queue-score, token-bucket, event-state, hold-state, seat-bitmap, errors, ports
│                 # (EventRepository, BookingRepository, HoldLedger, SeatLockStore, QueueStore,
│                 #  SeatMapStore, QuotaStore, HumanVerifier, AdmissionTokenPort)
├── application/  # launch-event, waiting-room, hold, confirm, seat-map, booking-query, reconciler services
├── infra/        # adapters (dynamo ledger, redis stores + Lua, human verifier), jobs/ (expire-hold,
│                 # open-sales, close-event, reconcile-seats), admitter, models/ (+ BookingEvent, LaunchEventHistory)
├── api/          # buyer controller, organizer controller, holds controller, dto, realtime-topics
├── launch-events.module.ts · launch-events-worker.module.ts · realtime-topics.module.ts · index.ts
└── launch-events-{queue,holds,confirm,seatmap,organizer,operations}.e2e-spec.ts
packages/backend/db/migrations/         # drop Shop FK; BookingEvent; LaunchEventHistory; new columns (expand only)
scripts/load-tests/launch-event.test.js # G-44
docs/spec/capabilities/S22-*.md         # new page (no S22 page exists yet); keep proof/code markers true
```

**Structure Decision**: keep the existing `launch-events` folder (S23 files untouched) and split the booking half into `domain/application/infra/api` per I.2.

## Order of work

Per gaps.md §4: (1) contracts, codes, migrations; (2) pure domain modules and unit specs; (3) ports, adapters, Lua; (4) application services and controllers; (5) jobs, admitter, outbox, voucher; (6) rewrite e2e and k6; (7) trim barrel, run static gates; (8) update domain-map "Emits" and the pattern-map row. Run `check:table-ownership` before starting and after finishing.

## Complexity Tracking

None.
