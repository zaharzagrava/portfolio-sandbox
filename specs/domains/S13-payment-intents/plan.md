# Implementation Plan: S13 — Payment Intents, Idempotency, Unknown Outcomes, PSP Circuit Breaker, Outbox, Saga with Orders (domain `payments`)

**Branch**: `S13-payment-intents` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md` (v3.1.0). Design artifacts: [research.md](research.md), [data-model.md](data-model.md), [contracts/http.md](contracts/http.md), [contracts/services.md](contracts/services.md), [contracts/events.md](contracts/events.md), [quickstart.md](quickstart.md).

## Summary

S01, S03, S05, S10, S49, S50, S53 and S54 are built; S14 (ledger) and S15 (payouts) are not. `payments` today takes a payment from a Kafka message the edge gateway writes with a client-chosen amount and key, charges the provider inside the message handler, decrements `Product.quantity` by raw SQL, retries a timed-out charge by redelivery (a blind resend), resolves unknown outcomes on a fixed cron by `updatedAt`, changes status with unversioned `UPDATE … WHERE status IN (…)`, publishes untyped events that carry the provider's whole intent, associates the order model, and serves reads from `apps/core` with a cross-owner join. The plan rebuilds the payment-intent part in the S01/S03/S05/S10 shape without changing the table owner:

- **Pure rules in `domain/`**: seven-status transition table (`assertNever`), money rules (1…99,999,999; EUR/USD/GBP), provider-answer classifier and validator, full-jitter backoff with injected random, order-copy payability, failure-code list, cursor codec, error classes with stable `code`s, ports and tokens (closes D-6, A14, A24–A26).
- **Accept** (`POST /payments/intents`): `@Idempotent()` + `@RateLimit('payments.create.user')`; amount/currency from the **order copy** (R3, fed by `orders.events`, version-guarded); one transaction inserts the payment (`ON CONFLICT ("orderId")`), its history row and the charge command (outbox task); no provider call, `202` + `Location`.
- **Charge**: a task worker (and a retry job) call one idempotent `charge()`: conditional "attempt started" update, provider call outside any transaction with the order ID as provider key, pure classification, one guarded transition. Not-sent (open breaker, `429`) retries with full jitter ≤ 6 attempts / 10 min; an ambiguous failure becomes `UNKNOWN` and is never re-sent (A4, A8, A9, A13).
- **One state writer** `PaymentTransitionService.apply`: conditional update by status and version, history row, ledger posting (S14's two names, wrapped locally), outbox event, push after commit — one `TransactionRunner.run`; the competing paths (charge, resolver, refresh, order events, refund) all use it (A14, A15, A16).
- **Unknown outcomes**: due time in the row, per-payment job + 60 s sweep with `SKIP LOCKED`, lookup by `orderId` metadata, jittered backoff, `no_provider_record` only after 60 min since the attempt, 24 h alarm (A10, A11).
- **Provider boundary**: `PAYMENT_PROVIDER` port; Stripe adapter with four `CircuitBreaker`s, call limits, SDK retries off, answer validation; the `is_load_test` branches become a fake adapter bound by DI (A9, A12, A23, A24, A30).
- **Saga with orders**: `orders.events` consumer (order copy; cancel unattempted or customer-pending payments), `orders.refund_requested` worker (full refund, durable wait jobs), `payments.events` out through the outbox with envelopes and no secrets, `getPaymentStatus` R1 export with provider refresh (A5, A17, A18, A16).
- **Reads and push**: `GET /payments/:id`, keyset `GET /payments`, `payment.status` on `user:<id>`; the `apps/core` payment-query code, the SSE stream and the gateway's Kafka route are deleted (A19–A21).
- **Boundaries**: no association or foreign key to orders/ledger, barrel shrinks to `PaymentModule`, `PaymentProcessorModule`, `PaymentQueryService` and the S14/S15 exports, raw `Product` SQL removed (D-6, D-7, D-8, D-11, D-12, D-15, D-17, C1–C5, C7).

## Follow-ups from already-built specs (each is a requirement, planned and tested here)

| From | Requirement | Where planned / proven |
|---|---|---|
| S05 | price and stock through `getProductsByIds` / `applyStockDelta`; drop `ProductModel` and `BelongsTo(Product)` (orders' item model) | S13's part: payments never reads price from the catalog (amount = order copy) and never touches stock; the raw `Product` SQL and the stock refund path are deleted (WP-13, C1, C2, A6); `payment.e2e-spec.ts` stops importing `ProductModel` (file replaced, WP-13); archived-product `unavailable` is S10's reservation concern, nothing to adapt here. Proof: `payment-boundary.e2e-spec.ts` (no `Product` in payments SQL, ownership remainder) |
| S10 | bind `PaymentStatusPort` by exporting `PaymentQueryService.getPaymentStatus(paymentRef)` | WP-11: export + `PaymentQueryStatusAdapter` in `orders/infra/payment-status.adapter.ts`, bound in `orders-core.module.ts`; `payment-status-service.e2e-spec.ts` (AS-55, AS-56); the orders webhook/payment-events suites re-run in WP-14 |
| S10 | publish `payments.events` `payments.payment_succeeded|failed|refunded` v1 with the payload S10 validates; take ownership of `packages/contracts/src/orders/payment-events.ts` if preferred | WP-1 (schemas moved to `packages/contracts/src/payments/`, `orders/payment-events.ts` re-exports; additive: nullable `paymentRef` on failed, `reasonCode`, `paymentVersion`), WP-3/WP-9 (publish), `payment-events.e2e-spec.ts` parses every event with the schemas and with S10's `PaymentsEventsConsumer` definitions |
| S10 | `orderId` in intent metadata; intent only from `OrderQueryService.getPayableOrder`, idempotency key = `orderId`; stop reading `paymentIdempotencyKey` | `orderId` metadata and key = `orderId`: WP-6 (AS-15). **Divergence recorded**: S13 does **not** call `getPayableOrder`; it uses the order copy, as `questions.md` (accepted defaults) decides, because `orders → payments` (status adapter) plus `payments → orders` would be an `orders ↔ payments` cycle (IV.2, X.5, D-11, AS-64). `paymentIdempotencyKey` is not read anywhere (the `idempotencyKey` column is legacy, unread, dropped at contract). Sibling bullet for S10 in `gaps.md` |
| S10 | consume `orders.refund_requested` v1 | WP-10 (`payment-refund.e2e-spec.ts`, AS-50–AS-54) |
| S10 | drop the `BisOrderModel` association and import in `payment.model.ts` and `ledger.module.ts`, and the lazy accessors on both sides (D-11); `payment.e2e-spec.ts` stops importing `BisOrderModel` | WP-2 (model), WP-13 (`ledger.module.ts`, orders-side `HasMany(Payment)` already removed by S10 — verified), `payment-boundary.e2e-spec.ts` |
| S10 (first pass) | orders no longer consumes `payment.processed`; consumes only `payments.payment_*`; the consumer refuses `amountMinor`/`currency` differing from the order; `OrderPaid.paymentRef` replaces `paymentId`; the ledger `paymentId` column now receives `paymentRef` from `settlement.listener.ts` — S14/S13 decide | WP-3/WP-9 publish exactly the amounts and currency of the order copy (AS-15 asserts them); the sale journal written by S13 uses the **payment id** in `LedgerEntry.paymentId`; `settlement.listener.ts` is left storing `paymentRef` (S14 decides) and gets a sibling bullet; its `OrderPaid` import becomes a local `defineEvent` on the contracts schema (WP-13) so payments no longer imports the orders barrel |
| S53 | move payments flows off `KafkaTopicGroup.payments.*`, `OutboxService.notify` and `KafkaConsumerService.consume` to `payments.events` and `appendTask`; the legacy consume path (G-27) is deleted after that | WP-13 deletes `payment.controller.ts` (`@EventPattern('payments.requests')`), `KafkaConsumerModule` from `payment.module.ts`, `PaymentProcessed`/`PAYMENTS_AGGREGATE`; the rest of the flow uses `OutboxService.append/appendTask` (WP-3, WP-5). Proof: `grep` gate in quickstart + `payment-boundary.e2e-spec.ts`; G-27 deletion itself is S53's (sibling bullet) |
| gaps.md | A1–A31, B (D-6, D-7, D-8, D-11, D-12, D-15, D-17), C1–C10, D, E | "Gap coverage" below |
| S54 rule 4 | no new direct `sequelize.transaction`; migrate sites in touched files and delete their `// S54 T037 audit` comment | The four sites in `payments` (`reconciliation.jobs.ts`, `payout.jobs.ts` ×3) are in files S13 does not touch (S14/S15). S13's new code uses `TransactionRunner.run` only. Gate: count stays 4 (`.tx.baseline`) and `grep` in quickstart |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend` domain `payments`; schemas in `packages/contracts`; edge route removal in `packages/edge-be`; web types are W03's.

**Primary Dependencies**: all present: `@nestjs/sequelize`/`sequelize-typescript`, `TransactionRunner` (`@app/infrastructure/context`), `@Idempotent` (`…/idempotency`), `OutboxService.append/appendTask`, `defineEvent`, S53 `Projector` + `ProjectionsModule.forProjectors`, `TaskQueue.consume`, `JobsService`/`@JobHandler`/`declareJobType`, S50 `definePolicies`/`@RateLimit`, `RealtimePublisher`, `CircuitBreaker` (`@app/common/resilience`), `Clock`/`CLOCK`, `StripeService` (thin client), `RedisService` (refresh gate), identity `Firewall`/`AuthenticatedUser`, zod, `fast-check` (dev). No new library.

**Storage**: PostgreSQL shared `public` schema: `Payment` (expanded), `PaymentHistory` (new), `PayableOrder` (new) — each registered `domain:payments`; Redis key `payments:refresh:<id>`; outbox/job/idempotency rows through the owning infrastructure libs. Kafka `payments.events` (produced), `orders.events` (consumed, own group), SQS `payments-charge` (produced and consumed) and `orders-refund-requested` (consumed).

**Testing**: Jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (eleven files of [test-plan.md](test-plan.md) + `payment-boundary.e2e-spec.ts`), four table-driven unit specs under `domain/` with `fast-check` for money; real Postgres/Redis/outbox/jobs; faked only at edges (the scriptable provider double, realtime hub spy, limiter store fault, `FakeClock`, identity fixture).

**Target Platform**: Linux containers: `apps/core` hosts `PaymentModule` (HTTP, R1); `apps/payment-processor` and `apps/worker` host `PaymentProcessorModule` (charge worker, refund worker, jobs, `orders.events` consumer through `ProjectionsModule`); `apps/sse-gateway` loses the payment stream. **No new deployable app** (I.6).

**Project Type**: web-service (backend domain) + contracts package.

**Performance Goals**: accept p99 < 100 ms with the order copy present (one indexed read + one three-statement transaction); no provider call on any HTTP path; `GET` = one indexed statement; list = one statement; with every breaker open the HTTP surface still answers under 300 ms (SC-002).

**Constraints**: no network I/O in a transaction (provider, Redis, realtime, task queue and job enqueue-to-SQS all outside; `JobsService.enqueue` and `appendTask` are the in-transaction writes the platform allows); every outbound call has a timeout (provider 8/4/2 s, connect 2 s, Redis 100 ms, realtime 500 ms, order-copy wait 2 s total); one retry layer (the charge retry; SDK retries 0); no unbounded statement (sweep ≤ 200, refund due ≤ 100, list ≤ 100); logs never carry `paymentMethodId`, `clientSecret`, provider secret, request bodies.

**Scale/Scope**: 3 routes (1 write, 2 reads), 3 events, 1 task + 2 consumed messages/streams, 5 job types, 2 rate policies, 1 R1 export, 3 tables (1 expanded, 2 new), 66 acceptance scenarios (twelve e2e files, four unit specs).

### Pool arithmetic and `statement_timeout` (III.12)

- `payments` adds no pool; it uses the shared pool of S54 (`db_pool_max` P = 10 per instance × 12 database-holding instances at the ceiling = 120, plus read replica 30 = 150, under `max_connections` 200 with 25 reserved; see S54 plan).
- Accept holds a connection for one read (outside) and one transaction of three statements (payment insert, history insert, outbox insert) ≈ 5 ms; at the 10/min/user limit and 1,000 concurrent buyers the in-transaction demand is ≈ 1,000 × 5 ms / 1 s ≈ 5 connections. The charge worker does: start-mark (1 statement, no transaction), provider call (no connection held), transition (one transaction ≈ 6 statements incl. ledger and outbox ≈ 10 ms). Worker concurrency 20 per instance is bounded by P through the pool queue — handlers wait on the pool, never open extra connections.
- Sweep and refund-due scans: ≤ 200 / ≤ 100 rows per run, one short transaction each (`FOR UPDATE SKIP LOCKED`), `fleetConcurrency: 1`.
- Pool-wide `db_statement_timeout_ms` applies; the keyset list and the due-selection statements are single indexed statements.

## Constitution Check

*GATE: passes before Phase 0 and re-checked after Phase 1 design (below).* Each line is a "Pull Request Compliance Gate".

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I.1–I.6, Communication Matrix, no `forwardRef`, no `Scope.REQUEST`) | **Pass** (one transitional exception, CT-1) | Layers per [Project Structure](#source-code-repository-root); `application/` reaches `infra/` only through `domain/ports.ts` tokens (the old `application → infra` and `application → api` imports are deleted, D-6); `domain/` takes `now` and `random` as parameters, imports nothing from Nest/Sequelize/Stripe; no new app. The S14/S15 files (`ledger.service.ts`, `payout.jobs.ts`, jobs for reconciliation) keep their current shape (CT-1) |
| 2 | Controllers (II.1), no HTTP `try/catch` outside the filter | **Pass** | One thin `PaymentController`: DTO in, one service call, DTO out; all problems are `AppError` subclasses raised in `application/`/`domain/`; the global filter renders them |
| 3 | Data access: principal-scoped queries (III.4), no network I/O in transactions (III.3), store-enforced invariants (III.6), integer money (III.8), keyset pagination (III.10) | **Pass** | `WHERE id = $1 AND "userId" = $2`; list has the same scope; transitions are conditional updates (III.7); unique index on `orderId`; `chargeAttemptedAt` condition makes cancel/charge exclusive; BIGINT minor units; keyset `(createdAt, id)` with signed cursor; provider/Redis/realtime/queue calls all outside transactions |
| 4 | Migrations expand/contract with `lock_timeout` (III.11) | **Pass** | [data-model.md](data-model.md): five expand/backfill migrations in this change, contract in a later release; concurrent index creation; enum value added in its own migration |
| 5 | Messaging: outbox, idempotent zod-validated consumers, timeouts (IV.4–IV.6) | **Pass** | Events through `OutboxService.append`, command through `appendTask`; consumers validate with zod (`Projector.handles`, `bodySchema`), idempotency mechanisms documented per consumer (version guard; payment state + job keys); poison messages to DLQ; every outbound call has a timeout; retry at one layer |
| 6 | Contracts: DTOs, `packages/contracts` schemas, problem+json, `Idempotency-Key` (V) | **Pass** | `packages/contracts/src/payments/*`; e2e parse every body; `@Idempotent()` on the POST; responses are mapped DTOs (no model, no `idempotencyKey`, no `providerRef`/`userId`) |
| 7 | Web | n/a | W03 owns screens; `gaps.md` sibling bullet for the `PaymentStatus` type |
| 8 | Tests: VII.2/VII.3 for every touched endpoint, VII.4 for consumers, Test plan updated, green run recorded (VII.8/9) | **Pass (to be proven by WP-14)** | [test-plan.md](test-plan.md) 66 rows → twelve e2e files (11 + boundary); no spec injects `ProductModel`/`BisOrderModel`/`UserModel`/`PaymentModel`; the recorded green run is the WP-14 acceptance |
| 9 | Operational: no secrets/PII in logs, probe semantics, jobs single-run and idempotent (VIII) | **Pass** | AS-62/63/66; redacting log keys; sweep `fleetConcurrency: 1` + `SKIP LOCKED`; breaker open ≠ readiness failure |
| 10 | Database isolation (IX) | **Pass after WP-13 (named remainder, CT-2)** | `payments` ownership findings 7 → 3 (S14/S15 files); associations removed; reads in the domain; new tables registered; cross-domain data via R3 (order copy) and R1 (status export) only |
| 11 | Monorepo boundaries (X) | **Pass (CT-1)** | Imports via entry points; `apps/core/src/payment-query` and `apps/sse-gateway/src/payment-stream` deleted (X.1); thin Stripe client stays in `infrastructure`, payment logic in the domain (X.3, X.7); `payments` no longer imports `orders` (X.5 acyclic) |

## Complexity Tracking

| ID | Rule | Why it cannot be met now | Simpler alternative rejected | Removal date |
|---|---|---|---|---|
| CT-1 | I.1/I.2 (layers) for S14/S15 files | `ledger.service.ts` (`application` importing `infra` model), `payout.jobs.ts`, `reconciliation.jobs.ts`, `balance.projector.ts` are the ledger/payout/reconciliation code of S14/S15, not payment intents; S13 only adds two methods to `LedgerService` and removes `Payment` associations from the ledger model | Rewriting the ledger here — would collide with S14's spec | with S14/S15 (planned after S13); S13 adds no new violation |
| CT-2 | IX.4 for three ownership rows | `ledger-entry.model.ts` (`User`), `finance-worker.module.ts` and `payout.jobs.ts` (`Shop`) belong to S14/S15 | Fixing them here — S14 and S15 specs already assign them | when S14 and S15 land (`check:table-ownership --strict` for `payments` = 0) |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S13-payment-intents/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ http.md  events.md  services.md
├── spec.md  test-plan.md  gaps.md  questions.md      # inputs (gaps.md gains "Sibling-spec follow-ups")
└── tasks.md                                          # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
packages/contracts/src/payments/
├── payment.ts            # createPaymentIntentRequestSchema, paymentAcceptedSchema, paymentSchema, paymentPageSchema, paymentListQuerySchema, status/currency/failure-code enums
├── payment-events.ts     # paymentEventSchemas (moved; payment_failed.paymentRef nullable, reasonCode, paymentVersion)
└── index.ts              # re-exported from src/index.ts; src/orders/payment-events.ts re-exports paymentEventSchemas

packages/backend/libs/domains/payments/
├── api/
│   ├── payment.controller.ts        # POST /payments/intents, GET /payments/:paymentId, GET /payments (new, thin)
│   ├── payment.dto.ts               # request DTO classes for ValidationPipe, mapped to the contracts schemas
│   ├── ledger.dto.ts  finance.controller.ts   # S14/S15, unchanged
├── application/
│   ├── payment-intent.service.ts  payment-charge.service.ts  payment-transition.service.ts
│   ├── payment-resolution.service.ts  payment-cancellation.service.ts  payment-refund.service.ts
│   ├── refund-request.service.ts  order-copy.service.ts  payment-query.service.ts
│   ├── events/payment-events.ts     # PaymentSucceeded/Failed/Refunded (defineEvent on contracts); order-events.ts (consumer-side definitions on contracts)
│   └── ledger.service.ts            # + recordPaymentCaptured / recordPaymentRefunded (S14 names)
├── domain/
│   ├── payment-status.ts  payment-amount.ts  provider-outcome.ts  backoff.ts  order-copy.ts
│   ├── failure-codes.ts  payment-errors.ts  payment-cursor.ts  payment-metrics.ts  ports.ts
│   └── payment-status.spec.ts  payment-amount.spec.ts  provider-outcome.spec.ts  backoff.spec.ts
├── infra/
│   ├── models/payment.model.ts (associations removed, new columns)  payment-history.model.ts  payable-order.model.ts
│   ├── payment.repository.ts  payment-history.repository.ts  order-copy.repository.ts  payment-read.repository.ts
│   ├── stripe-payment-provider.adapter.ts   # four breakers, limits, validation, classification input
│   ├── redis-refresh-gate.ts  realtime.adapter.ts  ledger-posting.adapter.ts
│   ├── orders-events.consumer.ts            # Projector, idempotency 'versionGuard'
│   ├── charge-command.worker.ts  refund-request.worker.ts   # TaskQueue.consume
│   └── payment.jobs.ts                      # charge, resolve-unknown, sweep-unknown, refund, cancel-intent
├── testing/
│   ├── payments-app.ts  fake-payment-provider.ts  fixtures.ts   # e2e kit, scriptable provider, seedPayment/seedPayableOrder, model exports for test/seeds
├── payment.module.ts  payment-processor.module.ts  rate-limit-policies.ts  index.ts
├── (S14/S15, unchanged shape) ledger.module.ts finance*.module.ts infra/{payout,reconciliation,ledger-maintenance,balance.projector,settlement.listener}.ts …
└── *.e2e-spec.ts   # payment-intent, payment-charge, payment-unknown, payment-breaker, payment-transitions, payment-order-events, payment-refund, payment-status-service, payment-events, payment-read, payment-ops, payment-boundary

packages/backend/libs/common/config/payments-config.ts      # validated settings (AS-65)
packages/backend/libs/infrastructure/stripe/                # thin client: breaker + is_load_test removed from createPaymentIntent; adds retrieve/search/cancel/refund-list helpers with explicit timeout and maxNetworkRetries 0
packages/backend/migrations/20261011…payments-s13-*.js      # five files (data-model.md)
packages/backend/db/ownership.ts                            # + PaymentHistory, PayableOrder
packages/backend/apps/payment-processor/src/payment-processor.module.ts   # PaymentProcessorModule
packages/edge-be/src/index.ts                               # gateway route to payments.requests removed
(deleted) apps/core/src/payment-query/*, apps/sse-gateway/src/payment-stream/*, libs/domains/payments/{api/payment.controller.ts old,application/payment.service.ts,infra/payment-dto.service.ts,infra/payment-resolution.jobs.ts,payment-dto.module.ts,payment.e2e-spec.ts}
```

**Structure Decision**: web-service backend domain plus contracts. No new deployable (I.6): HTTP in `core`; processor, consumers, jobs in `payment-processor`/`worker`. The payment-intent files are separated from the S14/S15 finance files already living in the same domain folder; they share only `LedgerService`.

## Work packages

Order follows `gaps.md` section F; each package ends with its narrowest test through `test-spec.sh` (or `npx jest` for units). `/speckit-tasks` splits them.

| WP | Content | Scenarios / gaps |
|---|---|---|
| WP-0 | Baseline: `check:table-ownership` for `payments` = **7** (recorded, matches section C of `gaps.md`); direct-transaction count = **4**; run the existing `payment.e2e-spec.ts`, `finance.e2e-spec.ts` and the orders payment suites to know what is green; confirm the in-memory `TaskQueue` and `FakeClock`-driven `CircuitBreaker` behave under Jest; confirm the `@Idempotent()` header rules (8–128 chars, `422` codes) with a throwaway probe; note whether `enum_Payment_status` exists under that name. | A29 (baseline), E |
| WP-1 | **Contracts and config**: `packages/contracts/src/payments/*`, move/loosen `payment-events.ts` (re-export from `orders/`), `payments-config.ts` + startup validation, `rate-limit-policies.ts`, metrics module, error classes with codes, `db/ownership.ts` rows, `payment-boundary.e2e-spec.ts` skeleton. | A21 (policies), A22 (metric names), A30, AS-65 |
| WP-2 | **Domain pure + persistence + provider boundary**: `payment-status`, `payment-amount`, `provider-outcome`, `backoff`, `order-copy`, cursor, errors, ports, 4 unit specs (`fast-check` for money); migrations 1–5; models (associations and lazy accessors removed, new columns); repositories; `StripePaymentProvider` (4 breakers, limits, `maxNetworkRetries: 0`, validation), thin-client changes in `libs/infrastructure/stripe`, `FakePaymentProvider`; e2e kit `testing/payments-app.ts` and fixtures. | A7, A9, A12, A13, A14 (table), A23–A26, A30; D-6, D-11, D-17; C3 |
| WP-3 | **Transition service**: `PaymentTransitionService.apply`, `LedgerService.recordPaymentCaptured/Refunded`, `LedgerPostingAdapter`, event definitions + payload builders (no secrets), `RealtimeAdapter` (`afterCommit`); proofs `payment-transitions.e2e-spec.ts`. | AS-39–AS-43; A14, A15, A16 |
| WP-4 | **Order copy and order-driven compensation**: `OrderCopyRepository` (version-guarded upsert), `OrderCopyService`, `orders-events.consumer.ts` (Projector), `PaymentCancellationService` (unattempted → cancel; customer-pending → cancel intent job; running/unknown untouched), `payments.cancel-intent` job; `payment-order-events.e2e-spec.ts`. | AS-44, AS-47–AS-49; A5, A17 |
| WP-5 | **Accept path**: controller `POST /payments/intents`, DTO, `@Idempotent()`, `@RateLimit`, `PaymentIntentService` (copy wait outside tx, payable and amount rules, one transaction), problem codes; `payment-intent.e2e-spec.ts` (incl. 50× two-key race, 5-way same key, limiter down, key lifetimes). | AS-01–AS-14; A1–A3, A27 (verified), A21 |
| WP-6 | **Charge use case**: `PaymentChargeService.charge`, `charge-command.worker.ts`, `payments.charge` retry job, start/clear mark, classification → transition (decline, rejected, requires action, invalid answer, order not payable), metadata and provider key; `payment-charge.e2e-spec.ts`. | AS-15–AS-22; A4, A8, A13 |
| WP-7 | **Breaker, retries, timeouts, degradation**: adapter behaviour proven end to end (open/half-open/close, declines don't count, slow calls count, per-operation separation, one retry layer, deadline `provider_unavailable`, no transaction held, HTTP independent of the provider); `payment-breaker.e2e-spec.ts`. | AS-31–AS-38; A9, A12 |
| WP-8 | **Unknown outcomes**: timeout → `UNKNOWN`, crash recovery, `PaymentResolutionService`, `payments.resolve-unknown`, `payments.sweep-unknown`, lookups by `orderId` metadata, 60-min/24-h rules, jitter, gauges; `payment-unknown.e2e-spec.ts`. | AS-23–AS-30; A8, A10, A11, A26 |
| WP-9 | **Events, outbox atomicity, push**: forced ledger/abort rollback, relay stop/resume, single publish, consumer sees twice, no I/O inside a transaction (call-log vs commit), hub down; `payment-events.e2e-spec.ts` (also parses events with `paymentEventSchemas` and S10's consumer definitions). | AS-45, AS-46, AS-61; A16 |
| WP-10 | **Refunds**: `refund-request.worker.ts`, `RefundRequestService`, `PaymentRefundService` (`REFUND_PENDING`, provider refund with lookup-first retries, reversing journal), `payments.refund` job, 24-h cap and alert metrics; `payment-refund.e2e-spec.ts`. | AS-50–AS-54; A17 |
| WP-11 | **Status service**: `PaymentQueryService.getPaymentStatus`, Redis refresh gate, mapping; orders-side `PaymentQueryStatusAdapter` + binding; `payment-status-service.e2e-spec.ts`. | AS-55, AS-56; A18; D-7 |
| WP-12 | **Reads and ops**: `GET /payments/:id`, `GET /payments` (keyset, signed cursor), read rate limit; observability, redaction, config validation, graceful shutdown of the charge worker; `payment-read.e2e-spec.ts`, `payment-ops.e2e-spec.ts`. | AS-57–AS-60, AS-62, AS-63, AS-65, AS-66; A19, A20 (stream deleted in WP-13), A21, A22, A30, A31 |
| WP-13 | **Boundary clean-up and barrel**: delete the old controller/service/jobs/DTO service/module and `payment.e2e-spec.ts`; delete `apps/core/src/payment-query/*`, `apps/sse-gateway/src/payment-stream/*`, the gateway route in `edge-be`; rewire `core.module.ts`, `worker.module.ts`, `payment-processor.module.ts`, SSE module; `index.ts` rewritten (S14/S15 exports kept); drop `UserModel`/`BisOrderModel` imports from `ledger.module.ts`; `settlement.listener.ts` import swap; `test/seeds/*` and `test/utils/global-modules.ts` import from `@app/domains/payments/testing`; `finance.e2e-spec.ts` adapted (resolver spy test moves to WP-8); `billing-gateway.port.ts` kept compiling (A28); finish `payment-boundary.e2e-spec.ts`. | A1, A6, A17–A20, A24, A25, A28, A29; B all; C1–C5, C7–C9; AS-64 |
| WP-14 | **Whole-capability run**: all twelve payments specs + unit specs, then the dependent suites in the quickstart; `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership` (7 → 3), `check:module-graph`, `check:no-wallclock`, `check:model-registry`; record the green run (VII.9); fill `UNVERIFIED.md`; write the report. | all |

## Gap coverage

| Gaps | Package | | Gaps | Package |
|---|---|---|---|---|
| A1, A2, A3 | WP-5 | | A19 | WP-12, WP-13 |
| A4, A8 | WP-6, WP-8 | | A20 | WP-3 (push), WP-13 (stream deleted) |
| A5 | WP-4, WP-5 | | A21 | WP-1, WP-5, WP-12 |
| A6 | WP-13 | | A22 | WP-1, WP-12 |
| A7 | WP-2 (currency/amount), WP-5 | | A23 | WP-2 (fake adapter), WP-13 |
| A9, A12 | WP-2, WP-7 | | A24, A25 | WP-2, WP-13 |
| A10, A11 | WP-8 | | A26 | WP-2 (injected clock), WP-8 |
| A13 | WP-2, WP-6 | | A27 | WP-0 (verify), WP-5 (route proof) — S54 owns the facility |
| A14 | WP-2 (table), WP-3 | | A28 | WP-13 (kept compiling) + sibling bullet |
| A15, A16 | WP-3, WP-9 | | A29 | WP-0, WP-13 (old spec replaced) |
| A17 | WP-4, WP-10 | | A30 | WP-1 |
| A18 | WP-11 | | A31 | WP-12 |
| B: D-6 → WP-2; D-7 → WP-13 (+ WP-11 for the R1/event replacement); D-8 → WP-13; D-11 → WP-2, WP-13; D-12 → WP-13; D-15 → WP-13 (verified by `check:module-graph`); D-17 → WP-2 | | | C1, C2 → WP-13; C3 → WP-2; C4 → S14 (sibling); C5 → WP-13 (both imports are unused, removed); C6 → S15; C7 → WP-12/WP-13; C8 → S10 side already done, verified in WP-13; C9 → WP-13 (import swap); C10 → S14 | |
| D (contracts): S10 (done, plus adapter WP-11), S14 wrappers (WP-3), S53/S49/S50/S51/S54 (consumed), S01 (`Firewall`), W03/S48 (sibling), edge gateway (WP-13) | | | E (migrations): 1–3 → WP-2; 4 (retire topics) → later release, noted; backfill → WP-2 | |

## Success-criteria proof

| SC | Proof |
|---|---|
| SC-001 | AS-05 (5 simultaneous), AS-06 (×50, two keys), provider create count 1 in `payment-intent.e2e-spec.ts`; the 200-run statistic is an Ops artifact + `UNVERIFIED.md` |
| SC-002 | AS-37 (one request and one read under 300 ms, all breakers open, readiness ready); the 99% over a sustained run is an Ops artifact + `UNVERIFIED.md` |
| SC-003 | AS-32 asserts one probe per 30 s and the spy count over a 60 s window (≤ 2) |
| SC-004 | AS-23 (one create across redeliveries/restarts), AS-24/AS-29 (settled within 2 min once reachable), AS-27 (24 h alert) |
| SC-005 | AS-40, 50 races: one transition, one journal, one event |
| SC-006 | AS-49/AS-50/AS-51 (exactly one refund per late completion); "within 5 minutes" timing is an Ops artifact + `UNVERIFIED.md` |
| SC-007 | `payment-read.e2e-spec.ts` matrix (every read and create route × other buyer × anonymous): identical `404`s, nothing changed (AS-10, AS-57, AS-59) |
| SC-008 | AS-45 (rollback → 0 events; stop between commit and relay → exactly 1); every flow spec asserts the event count |
| SC-009 | **Not proven by an automated wall-clock test**: the e2e proves push and read after the answer; the 5 s end-to-end figure is an Ops artifact + `UNVERIFIED.md` |
| SC-010 | ownership: `payment-boundary.e2e-spec.ts` + `check:table-ownership` (7 → 3, remainder in S14/S15 files) and `check:module-graph`; the 10,000-line log sample is an Ops artifact + `UNVERIFIED.md` |

## Re-check after Phase 1

Design artifacts re-read against the gates: (1) layers hold — `application/` talks to ports only, the only non-conforming code is the S14/S15 finance code S13 does not rewrite (CT-1); (2) the controller maps DTOs only; (3) every provider, Redis and realtime call sits outside a transaction, the start-of-charge mark is a single statement, cancel/charge exclusion is a row condition; (4) every new column is nullable or defaulted, the unique index is partial and built concurrently, the enum value ships alone; (5) events through the outbox, consumers zod-validated with documented idempotency, refund waits are durable jobs (research R-9); (6) schemas listed for every route; (8) a test row exists for every scenario; (10) two new tables registered, no association left in the owned models, reads principal-scoped; (11) `payments` no longer imports `orders`. **No gate fails; two named remainders (S14/S15 files) are in Complexity Tracking.** One deliberate divergence from a follow-up in the brief (`getPayableOrder`) is explained above and in `research.md` R-1.
