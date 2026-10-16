# Implementation Plan: J01 — Buy to Payout

**Branch**: `J01-buy-to-payout` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), constitution v3.1.0, and the follow-ups left by S10, S11, S14, S15, S16.

## Summary

J01 is a test-and-glue capability. Its product is (a) a black-box journey suite (`packages/backend/test/journeys/buy-to-payout.journey-spec.ts` + `support/`) and one Playwright test (AS-29), (b) the **journey control surface** (admin jobs, consumer admin, controllable clock, provider doubles) and (c) the hand-off repairs that the audit in [research.md](research.md) found still open after S10–S18 were built.

`gaps.md` was written before S10–S18 existed. A fresh code audit (research.md §1) shows most hand-offs are now **DONE** (HTTP intents, typed payment events, webhook→job→status check, refund saga, settlement deferral, payouts API, statements facts and periods, seller notifications, balance read). What is left:

| Work package | Gaps | Owner domain |
|---|---|---|
| WP1 Control surface: `POST/GET /api/admin/jobs`, consumer admin, clock | G-30, G-31, G-32 | S49 + S01 routes, S53, S54 |
| WP2 Commission at settlement from `CommissionRateQueryService` | G-10 (+ fee_mismatch ties AS-07/15) | S14 (consumes S16 export) |
| WP3 Provider doubles by `paymentMethodId` / `providerAccountId` | G-17 | S13, S15 (adapters) |
| WP4 Topics and queues provisioned and checked | G-27, L-002, L-020 | S53 / infra |
| WP5 Relay-shape e2e on a real topic message (both modes) | G-01 remainder | S53 |
| WP6 Verify partial items, fix what fails: `order.paid` payload fields, balance body, `ledger.journal_posted` v2, `payouts.events` subscription, monolith composition and `payment.status` on the stream | G-03, G-11, G-12, G-20, G-21, G-23 | per owner |
| WP7 Consumer idempotency proofs + the S10 event-rename importers | G-25, S10 follow-up | S28, S34/S39, S40, S43, S14 |
| WP8 DLQ redrive over HTTP and alert on depth | G-26 | S53 |
| WP9 Journey support kit and journey spec | G-33, G-34, G-37 | J01 |
| WP10 Web: W04 balance/payouts/statements screens + `buy-to-payout.spec.ts` | S14/S15/S16 follow-ups, AS-29 | W04 (web) |
| WP11 Static gates and runtime proofs | AS-30, AS-31, L-015/L-018/L-019 | all |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS monorepo (`packages/backend`, `packages/contracts`, `packages/web`).

**Primary Dependencies**: Sequelize + Postgres, Kafka (outbox relay poller/CDC), ElasticMQ (SQS), Redis, jest (`jest-journeys.json`, `pnpm test:journeys`), supertest is *not* used by journeys (real HTTP via `fetch`), Playwright for AS-29.

**Storage**: no new business tables for the journey. WP1 may add one table-free design (consumer pause flag lives in the existing projection-control store; clock offset in Redis, see research.md §4). Details in [data-model.md](data-model.md).

**Testing**: journey suite against the running local stack (`API_URL=http://localhost:8000`, watch mode: wait for `GET /health/ready` after backend edits); per-capability e2e through `scripts/sdd/test-spec.sh`; static gates `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`; `python3 scripts/livespec/check.py`.

**Target Platform**: Linux, single local deployment of all processes (`local-monolith`), each app also bootable on its own (L-018).

**Project Type**: web-service monorepo + Next.js web app.

**Performance Goals**: the hop table H1–H13 in spec.md is the contract (e.g. H3 5 s, H4 10 s, H8 15 s).

**Constraints**: control surface off outside the local/test profile (clock refused at startup in production); no fixed sleeps; journeys serial (`maxWorkers: 1`); journey always resumes consumers and resets the clock.

**Scale/Scope**: 31 acceptance scenarios, 8 domains, 3 new admin route groups, 1 Playwright test.

### Connection arithmetic (III.12)

No new pool is created. The journey runner opens no database connection (black box). Control-surface routes reuse the `core` API pool. Unchanged: pool size × instances (monolith: one process) stays below the Postgres limit already documented by S54.

## Constitution Check

*GATE — pre-research and post-design.*

| Rule | Status | Note |
|---|---|---|
| I/IV.1 module boundaries | PASS | Commission read goes through exported `CommissionRateQueryService` (R1); settlement does not import statements internals. Consumer admin lives in `infrastructure/projections`. |
| IV.2 no cycles / D-11 | PASS | Payments never imports orders; verified by AS-31 gate. |
| IV.3/IV.4 outbox | PASS | No new dual writes; WP5 proves the relay envelope. |
| IV.5 idempotent consumers | WORK | WP7 adds a same-message-twice and invalid-payload test for each `orders.events` consumer lacking one. |
| III.3 no I/O in tx | PASS | New code follows existing S54 toolkit (`TransactionRunner.run`/`@Transactional`); no direct `sequelize.transaction` added (audit: 0 sites in orders/payments/statements/notifications). |
| V.2/V.3 contracts + problem+json | WORK | New admin payloads get zod schemas in `packages/contracts` ([contracts/control-surface.md](contracts/control-surface.md)). |
| V.6 idempotency | PASS | `POST /api/admin/jobs` requires the key (409 in flight, 422 body mismatch). |
| VII.2/VII.3 e2e per endpoint | WORK | Each new route: happy, validation, 401, 403/404, idempotency, concurrency. |
| VII.4 consumer tests | WORK | WP7. |
| VII.8 traceability | PASS | `test-plan.md` has 31 rows; WP9 keeps scenario titles stable (L-017). |
| VIII safety | PASS | Clock and job allow-list guarded by config; pause/resume/replay need admin + sensitive session. |
| Cross-spec rule 0 (living spec) | WORK | Edit `docs/spec/capabilities` pages of S49, S53, S54, S14, S13, S15 first when behavior changes; keep `[proof]`/`[code]` true; never touch `*.reviewed.json`. |

Violations needing justification: none. Post-design re-check: same result (see data-model.md §Boundaries).

## Known-failure-class checklist (earlier loop failures)

- L-018/L-015/L-004: after WP1/WP3/WP4, boot `core`, `worker`, `projector`, `payment-processor`, `sse-gateway` standalone and the monolith; hit `/health/ready`. Scripted in quickstart.
- L-002/L-020: `orders-refund-requested` already in `infra/docker/elasticmq/elasticmq.conf`; any queue added is added there in the same change, readiness fails while a consumed queue is missing, and the reload command is in quickstart.
- L-001: any FIFO option (`groupId`) is validated where the task is created.
- L-010: fixture creation (shop, product) is idempotent: 409 → open existing.
- L-003: no "A or B" assertions; environment limits are reported as blocked.
- L-005/L-006: every journey test creates its own users, shops and products (`createIsolatedProduct` equivalents).
- L-007/L-008: runner timeouts; journeys run in batches by user story files if memory is tight; a batch without summary line is a crash.
- L-011: Kafka topics/Redis keyspaces/queues needed by WP1–WP4 appear in the test stack and the doctor.
- L-012/L-019: final checkpoint runs `scripts/qa/fresh-run.sh` and the browser suite once on an empty stack.
- L-013: pause/clock/payout-reject scenarios clean up in `afterAll` and a global `finally`.
- L-016: the repair path (`resume all`, `clock reset`) must not exit non-zero when nothing is paused.

## Follow-ups from built specs (each is a requirement here)

| From | Requirement | Work package / test |
|---|---|---|
| S10 | Importers adopt renamed `order.*` payloads and new `order.refunded`, `order.fulfilment_changed`: notifications router, experimentation `purchase-events`, developer-platform `webhook-router`, discovery `order-baskets`, seller-insights `{leaderboard,shop-sales,shop-live}`, payments `settlement` | WP7. Audit: leaderboard/shop-live/shop-sales/purchase-events already read `unitPriceMinor`/`totalMinor`; `order-baskets` and webhook-router unverified. The four e2e specs (`notifications`, `webhooks`, `leaderboards`, `finance`) must build the new payload; grep for `total:`/`price:`/`paymentId` in them. |
| S11 | `flashsale.*` names (no `flash_sale.*`) in consumers of `orders.events` | WP7: grep consumers for `flash_sale`, use `FLASH_SALE_EVENT_ALIASES`. |
| S14 | Journey asserts balance via `{shopId,currency,availableMinor,asOf,source}`; 400 on malformed shop id/unknown query prop | WP9 `JourneyClient` schema parse; AS-05 adds the two 400 checks. |
| S15 | Payouts page uses `payoutPageSchema` (statuses `PENDING|IN_TRANSIT|PAID|FAILED|CANCELLED`, keyset `nextCursor`) and `upcomingPayoutSchema` | WP9 client, WP10 screens. |
| S16 | Statements tab, "as known on" picker, CSV download journeys (D7) | WP10 (Playwright covers the tab and the picker; CSV download covered in the same file). |
| gaps.md | All rows | Table above + [research.md](research.md) §1. |

## Project Structure

### Documentation (this feature)

```text
specs/journeys/J01-buy-to-payout/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── control-surface.md
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
packages/contracts/src/admin/            # job, consumer, clock zod schemas (WP1)
packages/backend/
├── libs/domains/jobs|identity/…         # admin jobs routes over JobsAdminService (S49/S01)
├── libs/infrastructure/projections/     # consumer admin service + controller; DLQ redrive route (S53)
├── libs/infrastructure/clock/           # shared controllable clock (S54)
├── libs/domains/payments/               # commission at settlement (WP2); provider doubles (WP3)
├── libs/domains/{orders,notifications,…}/ # importer fixes + consumer idempotency tests (WP7)
├── scripts/init-kafka-topics.sh         # explicit topics (WP4)
├── test/journeys/
│   ├── buy-to-payout.journey-spec.ts
│   ├── README.md                        # JOURNEY_ENV, webhook secret (G-37)
│   └── support/{journey-client,wait-for-contract,seller-fixture,control-surface}.ts
packages/web/
├── app/dashboard/seller/[shopId]/…      # balance, payouts, statements (W04)
└── tests/buy-to-payout.spec.ts          # AS-29
infra/docker/elasticmq/elasticmq.conf    # queues (already has orders-refund-requested)
```

**Structure Decision**: control-surface code lives with the owner of each concern (S49 jobs, S53 consumers, S54 clock), not in a J01 module, because J01 has no runtime exports. The journey kit is test-only code under `test/journeys/support`.

## Phase order (matches gaps.md §4, updated)

1. WP4, WP5, WP1 (nothing observable without them) — then boot proof.
2. WP3, WP6 verification pass (write the journey early as the verifier: US1, US2 first).
3. WP2 (commission) with S14 spec page edit first; AS-05/07/13/15 tie out.
4. WP7, WP8.
5. WP9 remaining stories (US3–US8), WP10 UI.
6. WP11 final checkpoint: whole capability suite once, `pnpm test:journeys` on a fresh stack, standalone boots, browser suite once, livespec check.

## Complexity Tracking

No constitution violations. One judgment call: the consumer pause flag must be honoured by every process running that group; it is stored in Redis (shared) rather than in-process (see research.md §3).
