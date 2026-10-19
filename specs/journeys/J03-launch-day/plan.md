# Implementation Plan: J03 — Launch Day

**Branch**: `J03-launch-day` | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written; no line was edited by a human), constitution v3.1.0, and the follow-ups left by built specs: **(S22) J03 consumes `launch_events.booking_confirmed`, the seat map and the queue endpoints; (S23) J03 consumes the stream routes (staff routes under `/shops/:shopId/live/...`), `live.stream_started`, the event connection, `stats` and the pin; a `pin` event after an unpin is `{version, unpinned: true}`.**

## Summary

J03 is a test-and-glue capability: (a) one black-box API journey (`packages/backend/test/journeys/launch-day.journey-spec.ts`, 40 scenarios, six stories) with a kit extension in `test/journeys/support/`, (b) a **timing contract** (hop table H1–H30) and canonical consumer-group names, (c) the hand-off repairs that the audit in [research.md](research.md) found still open. `gaps.md` pre-dates S10/S11/S21/S22/S23/S28/S49/S53/S54: the audit shows the five domains are largely rebuilt (outbox events, settlement consumer, `createFixedPriceOrder`, consumers/jobs/clock admin routes exist). Static reading found these still open (each is verified first, then fixed in the owning domain):

| WP | Work | Gaps | Owner domain |
|---|---|---|---|
| WP1 | **Voucher hand-off**: orders consumer `orders-booking-voucher` of `orders.booking_voucher_requested` (idempotent on `booking-voucher:<holdId>`), voucher table, `GET /orders/vouchers`; the queue is already in `elasticmq.conf` | G-04, G-44 | S10 (S22 emits) |
| WP2 | **Notifications**: router rows, templates and catalog for `shop.flash_sale_sold_out`, `shop.flash_sale_start_failed`; verify `booking.confirmed`, the `order.cancelled` reason filter, the atomic unread counter, per-event isolation | G-05, G-26, G-27 | S28 |
| WP3 | **Event tap** `GET /api/admin/topics/:topic/messages` (admin, local profile, refused in production) | G-41 | S53 (identity hosts the admin controllers) |
| WP4 | **Control surface additions**: job allow-list `launch-events.reconcile-seats`, `auctions.sweep-due`, `flash-sale.verify`, `launch-events.live-reconcile`; queue-consumer pause/resume/lag for `orders-booking-voucher` | G-40, G-42 | S49, S53, S55 |
| WP5 | **Local doubles and fields**: classifier double (`[[toxic]]` → 0.95, else 0.05; local profile only); `admittedAt` on the ticket status | G-43, G-44 | S23, S22 |
| WP6 | **Verify-and-fix sweep** of rows the audit marks "built, unproven": confirm transaction and `HOLD_EXPIRED` (G-02, G-06), admission token purpose isolation (G-08), stream lifecycle and pin incl. `{version, unpinned: true}` (G-10, G-13), drop events/routes/stock command (G-16..G-19), bid durability and close ordering (G-20..G-24), consumer-group names and explicit topics (G-29, G-30), clock in all five domains (G-01) | G-01..G-03, G-06..G-25, G-29..G-31 | S22, S23, S11, S21, S10, S53, S54 |
| WP7 | **Journey kit and spec**: `launchFixture`, `sseClient`, `eventTap`, hop rows `J03.H1`..`J03.H30`, `launch-day.journey-spec.ts` (US1–US6) | G-45 | J03 |
| WP8 | Static gates, transaction migration, living spec, sibling follow-ups, ops artifacts | G-31, AS-40 | all |

Order of work follows research.md §3: write each story's journey slice first, run it, fix the owning domain. Gap G-46 (payment initiation) is J01's and already landed; AS-12, AS-33, AS-34 use J01's `support/purchase.ts`.

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`).

**Primary Dependencies**: Sequelize + Postgres, Kafka (outbox relay), ElasticMQ (SQS), Redis, jest (`jest-journeys.json`, `pnpm test:journeys`, `maxWorkers: 1`); journeys use real HTTP and SSE.

**Storage**: one new table (`Voucher`, owned by orders, expand migration); no new topic or queue: `orders-booking-voucher-requested` (+ DLQ) already exists in `infra/docker/elasticmq/elasticmq.conf` (L-002, L-020); topics created explicitly by `scripts/init-kafka-topics.sh` (verify, G-30). See [data-model.md](data-model.md).

**Testing**: per-capability e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; journeys against the running stack (`API_URL=http://localhost:8000`; after backend edits `bash scripts/sdd/stack-fix.sh api-ready`); static gates `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`, `tsc --noEmit`; `python3 scripts/livespec/check.py`.

**Target Platform**: Linux; one local deployment (`local-monolith`); every app also boots alone (L-018).

**Project Type**: web-service monorepo (API journey; **no UI scenario**).

**Performance Goals**: hop table in spec.md (H4 5 s, H5 10 s, H18 1 s, H21 1 s, …); deadline = 2 × maximum × `JOURNEY_TIME_FACTOR`; SC-009: green in under 15 minutes.

**Constraints**: provider doubles, clock control and the event tap refused at startup in production; no fixed sleeps; journeys serial (clock and consumer pauses are global, L-029); `afterAll` always resumes consumers and resets the clock.

**Scale/Scope**: 40 scenarios, 5 domains; sizes 40 seats, 12 buyers, 20 units, 60 racers, 30 comments.

### Connection arithmetic (III.12)

No new pool; the runner opens no database connection. The voucher consumer uses the existing worker pool and one short transaction per message. Unchanged from S54's sizing.

## Constitution Check

*GATE — pre-research and post-design.*

| Rule | Status | Note |
|---|---|---|
| I/IV.1 boundaries, IX.7 R1–R3 | WORK | Orders consumes the voucher command (R2 task); launch-events, auctions, live reach catalog, tenancy, identity, orders only through exported services (`check:boundaries`, AS-40). |
| IV.2 no cycles / D-11 | WORK | `check:module-graph`: no orders → launch-events edge (the command is a queue message). |
| IV.3/IV.4 outbox | WORK | Verify confirm, stream, drop and auction transitions append in the deciding transaction; the voucher command is outbox-written. |
| IV.5 idempotent consumers | WORK | `orders-booking-voucher`, `notification-router` (new rows), `auctions-order-results`, `live-*`: same-message-twice and invalid-payload test each. |
| III.3 no I/O in tx | WORK | Confirm: no Dynamo/Redis call inside the transaction (verify G-02). |
| III.8 transactions (S54) | WORK | New code uses `TransactionRunner.run`/`@Transactional`; each touched `// S54 T037 audit` site is migrated and the comment deleted; the direct-site count must not rise. |
| V.2/V.3 contracts, problem+json | WORK | Schemas in `packages/contracts` for vouchers, tap, ticket `admittedAt`; stable codes (`HOLD_EXPIRED`, `live_unavailable`, …). |
| V.6 idempotency | WORK | Hold, confirm, checkout, auction create/bid, comment `clientId` (verify per route). |
| VII.2/VII.3 e2e per endpoint | WORK | `GET /orders/vouchers`, tap, allow-list additions, classifier double get e2e. |
| VII.8 traceability | PASS | `test-plan.md` has 40 rows; scenario titles keep a stable `AS-nn` prefix (L-017). |
| VIII safety | PASS | Tap, doubles and clock refused in production; tokens, keys, e-mails and maxima never in logs/events (FR-030, AS-39 scan). |
| IX table ownership | WORK | `Voucher` owned by orders; `check:table-ownership --strict` for five domains (D-7, D-12). |
| Rule 0 living spec | WORK | Edit pages S10, S11, S21, S22, S23, S28, S49, S53 before behaviour changes; keep `[proof]`/`[code]` true; never touch `*.reviewed.json`; signed changes go under `## Spec changes` in gaps.md. |

Violations needing justification: none. Post-design re-check: same result (data-model.md §Boundary check).

## Known-failure-class checklist

- **L-018/L-015/L-004**: after WP1/WP3/WP4 boot `core`, `worker`, `projector`, `sse-gateway` standalone, then the monolith; `/health/ready` 200 (listed in quickstart; run at the final checkpoint, not a task).
- **L-002/L-020/L-025**: the voucher queue is in `elasticmq.conf`; its consumer runs in the local deployment from the first minute; readiness fails while it is missing.
- **L-001**: the voucher command is a standard-queue message: no `groupId`.
- **L-010**: fixture creation is idempotent (409 → open existing).
- **L-003**: no "A or B" assertions; absence only after `lag: 0` plus the hop maximum on the stack clock.
- **L-005/L-006**: each story creates its own products, event, drop, stream, auction (`createIsolatedProduct`).
- **L-007/L-008/L-023**: runner timeouts; run per story with `-t`; a batch without a summary line is a crash.
- **L-011**: the new table is a migration; topics and queue already exist (doctor compared in quickstart).
- **L-013/L-016**: `restoreAll()` is idempotent and exits 0 when nothing is paused; the voucher consumer is resumed in `afterAll`.
- **L-029**: clock and pauses are global; the J03 file never runs in parallel with another journey.
- **L-012/L-019**: runtime proofs belong to the final checkpoint and are **not** tasks.

## Follow-ups from built specs (each is a requirement here)

| From | Requirement | Work package / test |
|---|---|---|
| S22 | J03 consumes `launch_events.booking_confirmed`, the seat map and the queue endpoints | WP1, WP2, WP5, WP7: AS-01..AS-09 (effect asserted through inbox + voucher; tap only for events with no consumer, per questions.md) |
| S23 | J03 consumes staff stream routes under `/shops/:shopId/live/...`, `live.stream_started`, the event connection, `stats`, the pin; `pin` after unpin is `{version, unpinned: true}` | WP6, WP7: AS-19, AS-22, AS-26 (viewer receives `{version, unpinned: true}`; `stats` stops after end) |
| gaps.md | Every row (code fixes and constitution debt D-7, D-8, D-11, D-12) | table above, research.md §1, WP8 |

## Project Structure

### Documentation (this feature)

```text
specs/journeys/J03-launch-day/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/journey-kit.md
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/                       # voucher page, event tap, ticket admittedAt
packages/backend/
├── libs/domains/orders/                      # voucher consumer, model, route (WP1)
├── libs/domains/notifications/               # router rows, templates, catalog (WP2)
├── libs/domains/identity/api/                # topics-admin controller, jobs allow-list, consumers (WP3, WP4)
├── libs/domains/launch-events/               # admittedAt, classifier double, verify sweep (WP5, WP6)
├── libs/domains/auctions/                    # verify sweep (WP6)
├── scripts/init-kafka-topics.sh              # explicit topics (verify)
└── test/journeys/
    ├── launch-day.journey-spec.ts
    ├── README.md                             # J03 variables and fixtures
    └── support/{launch-fixture,sse-client,event-tap,wait-for-contract,control-surface}.ts
docs/spec/capabilities/                       # pages edited first (rule 0)
```

**Structure Decision**: fixes live with the owning domain; the kit is test-only code under `test/journeys/support`, shared with J01/J02. J03 has no runtime module.

## Phase order

1. WP3, WP4, WP5 (nothing is observable or drivable without tap, allow-list, doubles), then the US1 slice with WP1.
2. WP2 → US1 notice and US2 slices; WP6 fixes found by each slice, in the owning domain.
3. US3, US4 slices; US5 (one buyer, everything at once); US6 observability.
4. WP8: static gates, transaction migration, living spec, ops artifacts.
5. Final checkpoint (run by the loop, not a task): capability suites once, `pnpm test:journeys`, standalone boots, fresh stack.

## Complexity Tracking

No violations. Judgment calls: (1) voucher as its own record, not a zero-amount order (questions.md); (2) event tap instead of reading topics from the test (black-box rule).
