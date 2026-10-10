# Research: S13 — Payment Intents (domain `payments`)

Phase 0 of `/speckit-plan`. `spec.md` has no `NEEDS CLARIFICATION`; this file records the design decisions that the spec leaves to the plan, found by reading the code and the S53/S54/S49/S50/S10 building blocks as they exist on 2026-10-10. Format: Decision / Rationale / Alternatives.

## Facts found in the repository

| Fact | Where | Consequence |
|---|---|---|
| `check:table-ownership` reports **7** findings for `payments` (the baseline in `.ownership.baseline`): `Product` SQL in `payment.service.ts`; `UserModel` in `ledger-entry.model.ts` and `ledger.module.ts`; `BisOrderModel` in `payment.model.ts` and `ledger.module.ts`; `ShopModel` in `finance-worker.module.ts` and `payout.jobs.ts`. Section C of `gaps.md` matches (C7 and C8 live in `apps/core` and `orders`, which the scanner does not list under `payments`) | `pnpm check:table-ownership` run on 2026-10-10 | Target after S13: **3** (`ledger-entry.model.ts` User is S14's, the two `Shop` rows are S15's). S13 clears 4 (C1/C2, C3, both rows of C5) |
| Direct `sequelize.transaction` sites in `payments`: **4**, all in `reconciliation.jobs.ts` (S14) and `payout.jobs.ts` (S15), each with a `// S54 T037 audit` comment (`.tx.baseline` = 4). The payment-intent files (`payment.service.ts`, `payment-resolution.jobs.ts`, `settlement.listener.ts`) already have none or use `TransactionRunner` | grep | S13 adds none and touches none of the four files; the new code uses `TransactionRunner.run` only. Gate: count stays 4 |
| `CircuitBreaker` (`@app/common/resilience`) is a generic primitive with `windowMs`, `minimumCalls`, `failureRateThreshold`, `slowCallMs`, `openDurationMs`, `halfOpenCalls`, `isFailure`, injected `Clock`, metrics gauge by `name`, `CircuitOpenError` | `libs/common/resilience/circuit-breaker.ts` | Exactly the options FR-021/FR-022 need; no new breaker library. `StripeService` already builds one for create only (30 s window, 5 calls, 10 s open) — replaced by four breakers with the spec numbers, built in the payments adapter, not in the thin client |
| S10 is built: `order.reserved|paid|cancelled` carry `userId`, `totalMinor`, `currency`, `reservedUntil`, `orderVersion` (`packages/contracts/src/orders/order-events.ts`); `order.cancelled` carries **no** amounts (`reason`, `previousStatus`); the refund command is an outbox **task** on queue `orders-refund-requested`, type `orders.refund_requested`, group key `orderId`, body = `refundRequestedSchema` | `orders/infra/refund-command.adapter.ts`, `order-events.ts` | The order copy must accept a `CANCELLED` row without amounts; the refund consumer reads the queue through `TaskQueue.consume` |
| S10 binds `PAYMENT_STATUS` to `PaymentStatusUnavailableAdapter` (fail closed) in `orders-core.module.ts:90`; its port expects `{status: COMPLETED\|PENDING\|FAILED\|REFUNDED\|UNKNOWN, amountMinor, currency}` and throws `PaymentStatusUnavailableError` | `orders/domain/ports.ts:249-258` | S13 exports `PaymentQueryService.getPaymentStatus` and ships the one-class adapter that binds it (WP-13), so the live webhook path stops ending `FAILED` |
| S10's consumer of `payments.events` already validates with `paymentEventSchemas` and uses `defineEvent('payments.payment_succeeded', 'payments', 1, …)`; its `payment_failed` handler ignores `paymentRef` | `orders/infra/payments-events.consumer.ts`, `orders/application/events/payment-events.ts` | S13 takes ownership of `packages/contracts/src/orders/payment-events.ts`: moves the schemas to `src/payments/`, loosens `payment_failed.paymentRef` to nullable and adds `reasonCode` and `paymentVersion`; `orders/payment-events.ts` re-exports so S10's import keeps working (additive, V.7) |
| `OutboxService.append(event, tx)` and `appendTask({queue,type,aggregateId,groupId,body}, tx)` need an active transaction (`NoActiveTransactionError`) | `outbox.service.ts` | Accept path, every transition and every command is written inside `TransactionRunner.run` |
| The S53 consumer framework (`Projector`: `name`, `topics`, `idempotency`, `handles`, `project`; `PermanentError` → DLQ, `TransientError` → retry) is what `PaymentsEventsConsumer` and `SettlementListener` use; single-consumer queues use `TaskQueue.consume(queue, handler, {bodySchema, deadLetterQueue})` with SQS visibility-timeout redelivery and a queue-level `maxReceiveCount` | `projections/projector.ts`, `sqs/task-queue.port.ts` | `orders.events` → a `Projector` (`idempotency: 'versionGuard'`); `orders.refund_requested` and the charge command → `TaskQueue.consume` workers |
| `JobsService.enqueue(type, payload, {runAt, idempotencyKey, maxAttempts})` joins the caller's transaction; `@JobHandler(type, options)` registers handlers; periodic schedules and single-run leases exist (S49) | `jobs/jobs.service.ts`, `job-handler.decorator.ts` | Delayed per-payment work (resolve, retry charge, refund retry, cancel-intent retry) and the 60 s sweep are S49 jobs |
| `@Idempotent()` (S54) already gives: mandatory `Idempotency-Key` (`422 idempotency_key_required`), replay with `Idempotency-Replayed: true` and replayed `Content-Type`/`Location`, in-flight `409`, reuse `422`, TTL default 24 h. S10's checkout uses it with the same codes | `idempotency/idempotency.interceptor.ts` | A27 is already fixed by S54; S13 uses the decorator and adds an e2e proof of each code on its own route (the 8–128 `[A-Za-z0-9_-]` key rule and "failures before a record exists are not remembered" are asserted, not assumed) |
| `user:<userId>` is already a registered realtime topic (identity) and `RealtimePublisher.publish(topic, type, data)` exists | `identity/api/realtime-topics.ts`, `realtime-publisher.service.ts` | No topic registration in S13 |
| `Payment.bisOrderId` is `STRING`; `Payment.amount` is `BIGINT` (already minor units); the status column is a Postgres `ENUM` (`enum_Payment_status`); `userId` is `STRING NOT NULL`; `id` default `uuidv7()` | `payment.model.ts`, migration `20260815083235-denormalize-user-id-to-payment.js` | `REFUND_PENDING` needs `ALTER TYPE … ADD VALUE` (separate migration step, committed before use); `orderId` is added as a new TEXT column and backfilled (expand) |
| `LedgerService` has `post()` (balanced journal, `JournalPosted` through the outbox, in the caller's transaction) and `recordMarketplaceSale(...)` that opens a second wrapper transaction via `DbUtilsService`; no reversal; no `recordPaymentCaptured`/`recordPaymentRefunded` (S14 not built) | `ledger.service.ts` | WP-6 adds the two S14 names to `LedgerService` as thin wrappers over `post()` with the fee/account rules moved inside (`domain/accounts.ts`), keeping the names and signatures S14 promises (spec CONTRACT 8) |
| `SettlementListener` (S14's) imports `OrderPaid` from `@app/domains/orders` and stores `paymentRef` in the ledger `paymentId` column | `infra/settlement.listener.ts:10,87` | An import of the orders barrel from payments plus orders → payments (the status adapter) would recreate the `orders ↔ payments` cycle (AS-64). WP-13 swaps that import for a payments-side `defineEvent('order.paid', …)` built on the shared contracts schema (same payload, no orders import). The ledger column semantics stay S14's (sibling bullet) |

## Decisions

### R-1 The order is read from an order copy; `getPayableOrder` is not called (questions.md CONTRACT 1 stands)

**Decision**: payments keeps `PayableOrder` (R3 read model) fed by `order.reserved|paid|cancelled`, version-guarded by `orderVersion`; the accept path polls it up to 2 s outside any transaction; it never calls `OrderQueryService.getPayableOrder`.

**Rationale**: the task brief repeats S10's earlier sentence "create an intent only from `OrderQueryService.getPayableOrder`". `questions.md` — whose defaults the human accepted as written — decides the opposite on purpose: `orders → payments` (the status adapter) plus `payments → orders` (`getPayableOrder`) is the module cycle that constitution IV.2 and X.5 and debt D-11/D-15 forbid, and AS-64 requires no `orders ↔ payments` cycle. `questions.md` overrides the brief; S10's `getPayableOrder` stays for its other consumers. Recorded as a sibling bullet for S10 in `gaps.md` and in the report.

**Alternatives**: call `getPayableOrder` (R1) — rejected, cycle; move the call behind a port bound by the app — rejected, hides the cycle in DI and breaks the static graph check.

### R-2 Idempotency stack: two layers, neither is the provider key

**Decision**: HTTP layer = `@Idempotent()` (per principal, 24 h). Store layer = unique index on `Payment.orderId` + `INSERT … ON CONFLICT (orderId) DO NOTHING RETURNING` (the loser reads the existing payment id and answers `409 payment_already_exists`). Provider layer = Stripe idempotency key = `orderId` for create, `refund:<paymentId>`, `cancel:<paymentId>`.

**Rationale**: III.6 (store-enforced uniqueness), FR-004, FR-009. AS-06 runs two different keys at once 50 times; only the unique index can make that exact. The old `idempotencyKey` column stays (nullable, unused) until the contract step and is never read.

**Alternatives**: advisory lock per order — rejected (index is simpler and survives bugs); keying the provider by `paymentId` — rejected: S10's contract and the 10/07 note use the order ID, and it lets the lookup-by-reference of AS-24 use the same value.

### R-3 Charge command = outbox task; delays and retries = S49 jobs; one use case behind both

**Decision**: the accept transaction writes `Payment`, `PaymentHistory`, and `outbox.appendTask({queue: 'payments-charge', type: 'payments.charge_requested', aggregateId: paymentId, groupId: paymentId, body: {paymentId, attempt: 0}})`. A `TaskQueue.consume` worker calls `PaymentChargeService.charge(paymentId, attempt)`. When a charge was **not sent** (breaker open, `429`), the service enqueues job `payments.charge` `{paymentId, attempt+1}` with `runAt = now + fullJitter(2 s × 2^n, cap 60 s)` inside the transaction that records the retry, and acknowledges the command. The job handler calls the same `charge()`.

**Rationale**: AS-01/AS-46 want the command in the outbox row; SQS visibility timeouts cannot express per-attempt jittered delays up to 60 s with a 10-minute budget and a deadline check, and `maxReceiveCount` is queue-wide; S49 jobs give `runAt`, attempt counts and a dead-letter state. `charge()` is idempotent by the row guard (R-4), so a command delivered twice or a command plus a job cannot double charge.

**Alternatives**: only SQS redelivery — rejected (cannot enforce the 6-attempt/10-minute rule or full jitter); only jobs, no outbox command — rejected (spec AS-01 says the command is an outbox row; the task also keeps `payments-charge` ordered per payment).

### R-4 The charge attempt and the cancel decision exclude each other in one row (AS-30, AS-43)

**Decision**: `Payment.chargeAttemptedAt` and `chargeAttempts`. Starting a charge is one conditional update `SET "chargeAttemptedAt" = :now, "chargeAttempts" = "chargeAttempts" + 1 WHERE id = :id AND status = 'PENDING' AND "chargeAttemptedAt" IS NULL` (no version bump, no history; AS-23 shows `PENDING → UNKNOWN` as version 2). `cancel` is `… SET status='CANCELLED', version = version+1 … WHERE status = 'PENDING' AND "chargeAttemptedAt" IS NULL AND version = :v`. Whichever statement matches first wins; the other matches zero rows. A start that matches zero rows because an attempt is already recorded and no result applied → `UNKNOWN(crash_recovery)` (the attempt may have reached the provider). A start refused by the breaker/`429` (nothing sent) clears the mark again (`SET "chargeAttemptedAt" = NULL WHERE id = :id AND "chargeAttemptedAt" = :t AND status = 'PENDING'`) and schedules the retry. A crash between "record" and "clear" is therefore treated as possibly sent: safe (settled by lookup; `no_provider_record` after 60 minutes).

**Rationale**: a single store-enforced decision (III.6/III.7); no lock, no check-then-write.

**Alternatives**: admission check on the breaker before recording — rejected: a half-open probe slot can be lost between check and call; `SELECT … FOR UPDATE` across the provider call — forbidden (III.3).

### R-5 Provider port with four breakers, SDK retries off, load-test fake bound by DI

**Decision**: `domain/ports.ts` defines `PAYMENT_PROVIDER` with `createIntent`, `retrieveIntent`, `findIntentByReference`, `cancelIntent`, `createRefund`, `findRefunds`. Results are a discriminated union (`ProviderResult`: `{kind:'answer', intent}` | `{kind:'declined', code}` | `{kind:'rejected'}` | `{kind:'not_sent', reason}` | `{kind:'unknown', reason: 'timeout'|'connection'|'server_error'}` | `{kind:'invalid', field}`); `domain/provider-outcome.ts` is the pure classifier and validator. The adapter `StripePaymentProvider` (infra) wraps the thin `StripeService` client, owns four `CircuitBreaker`s (`create_intent`, `retrieve_intent`, `cancel_intent`, `refund`: 10 s / ≥ 10 calls / 50% / 5 s slow / 30 s open / 1 probe; `isFailure` = timeout, connection, `5xx`, `429`), applies per-call `AbortSignal`/SDK `timeout` (8 s, 4 s, 2 s; connect 2 s) and builds the SDK with `maxNetworkRetries: 0`. The `is_load_test` branches leave `StripeService`; a `FakePaymentProvider` is bound instead in the load-test environment and in specs (the scriptable double of the test plan).

**Rationale**: IV.8, IV.6 (one retry layer), A9 (a call that tripped the breaker must still be reported as what it was), A23. The adapter classifies the **error that happened** and only reports `not_sent` when `CircuitOpenError` came from admission.

**Alternatives**: keep breakers in `StripeService` — rejected (X.3: infrastructure stays a thin generic client; payment rules live in the domain's adapter, S43/S46 reuse the generic `CircuitBreaker`).

### R-6 Unknown outcomes: due time in the row, job per payment, sweep as the safety net

**Decision**: `Payment.nextResolveAt`, `resolveChecks`, `unknownSince`. Entering `UNKNOWN` sets `nextResolveAt = now + 30 s` and enqueues job `payments.resolve-unknown` `{paymentId}` (idempotency key `resolve:<paymentId>:<resolveChecks>`) with `runAt = nextResolveAt`. `payments.sweep-unknown` (`*/60 s`, `fleetConcurrency: 1`) selects `status='UNKNOWN' AND nextResolveAt <= now` in batches (partial index), `FOR UPDATE SKIP LOCKED`, enqueues the resolve job for each with a per-check idempotency key. A resolve run: lookup (no transaction) → apply result through the shared transition (R-7) or reschedule with `delay = random × min(15 min, 30 s × 2^checks)` (full jitter, injected random). Beyond 24 h: warning once per hour (a `lastAlertAt` column is not needed — the job logs when `floor(ageHours)` changes, tracked by `resolveChecks`-independent `lastStuckAlertAt`; see data-model) and the age gauge; never auto-fails.

**Rationale**: FR-018–FR-020, AS-27, AS-29; a lost job cannot strand a payment because the row carries the due time.

### R-7 One state writer: `PaymentTransitionService.apply`

**Decision**: every status change (accept's initial insert aside) goes through `PaymentTransitionService.apply(paymentId, command, ctx)` in `application/`. It loads nothing outside the transaction guard: inside one `TransactionRunner.run` it executes the conditional update `UPDATE "Payment" SET status=:to, version=version+1, … WHERE id=:id AND status=:from AND version=:v` (rows must be 1; 0 rows → re-read and report `already_applied`/`conflict`), inserts one `PaymentHistory` row, calls the ledger wrapper for `COMPLETED` and `REFUNDED`, appends the event for `COMPLETED|FAILED|CANCELLED|REFUNDED`, and registers an `afterCommit` hook for the realtime push. The pure table is `domain/payment-status.ts` with `assertNever`. Callers: charge, resolver, refresh, order-cancel, refund.

**Rationale**: III.7, FR-026, AS-40/AS-42. The racers (AS-40) all call `apply`; exactly one update matches, the rest see `already_applied` and return a normal result — no exception as control flow (A14).

**Alternatives**: `PaymentDtoService.update` throwing "not found" — rejected (the gap itself).

### R-8 Ledger link now: S14's two names, wrapped locally

**Decision**: add `LedgerService.recordPaymentCaptured({paymentId, userId, amountMinor, currency}, tx)` and `recordPaymentRefunded({paymentId, amountMinor, currency}, tx)` returning `{journalId}`. Journal ids are deterministic (`uuidv5('sale:'+paymentId)`, `uuidv5('refund:'+paymentId)`), idempotent (existence check under the transaction), posted through the existing `post()` with account ids from `domain/accounts.ts` (`buyer`, `CLEARING`, `PLATFORM_REVENUE`); the reversal posts the exact opposite lines. The previous `recordMarketplaceSale` stays for the reconciliation job that still calls it until S14.

**Rationale**: spec CONTRACT 8 says S13 calls these names and wraps `recordMarketplaceSale` "inside this domain" until S14. `post()` already enforces balance in code and with the deferred constraint trigger.

**Alternatives**: wait for S14 — rejected, S13 cannot prove AS-15/AS-50 without a journal.

### R-9 Refund waits are durable jobs, not broker redelivery

**Decision**: the `orders.refund_requested` consumer (a `TaskQueue.consume` worker with `bodySchema`) validates, then: `COMPLETED` → transition to `REFUND_PENDING` and enqueue job `payments.refund` `{paymentId}` (key `refund:<paymentId>`, `runAt = now`); `REFUND_PENDING|REFUNDED` → ack; `FAILED|CANCELLED` → ack as `nothing_to_refund`; `PENDING` without attempt → cancel (AS-48); `UNKNOWN` or attempted `PENDING` → **enqueue the same job with `runAt = now + backoff`** (idempotency key `refund-wait:<paymentId>`), store `Payment.refundRequestedAt` (first request time) and **acknowledge the message**. The job re-checks the state each time; it ends at the 24 h cap by writing a dead-letter record (a `payments_consumer_dead_lettered_total{reason="refund_wait_expired"}` and an error log; the job type's dead-letter state is the durable record). Mismatches/invalid bodies are rejected at the consumer to the queue's DLQ (`bodySchema` → `SCHEMA_INVALID`; the semantic ones — amount, currency, ref, unknown payment, unsupported reason — go to the DLQ through a `PermanentError`-equivalent: the worker sends the message to `orders-refund-requested-dlq` explicitly and counts the reason).

**Rationale**: a queue-level `maxReceiveCount` (SQS) would dead-letter after a handful of redeliveries — far short of 24 h with backoff — and visibility timeouts max out at 12 h. A durable job carries `runAt`, attempts and a terminal state. The observable behaviour AS-52 specifies (no change while unsettled, refunded once it settles, "nothing to refund" on failure, alert at 24 h) is preserved; the only difference is that "redelivered" is implemented as "re-run by the scheduler". The test plan row for AS-52 is read that way (the e2e invokes the job handler with the clock moved).

**Alternatives**: `throw` to let SQS redeliver — rejected (above); a dedicated delay queue — rejected (S53/S49 already provide delayed jobs).

### R-10 `getPaymentStatus` refresh: per-payment 2 s coalescing in Redis, not in memory

**Decision**: the refresh takes `SET payments:refresh:<paymentId> 1 NX PX 2000` (Redis); the winner calls `retrieveIntent` (2 s limit) and applies the result through `apply`; callers that lose the `SET` read the stored status (they do not wait). Redis outage → no refresh, stored status (never throws). Terminal statuses skip the provider call. `UNKNOWN` runs the lookup path of AS-24. The call is outside any transaction.

**Rationale**: AS-56 (ten concurrent callers, one retrieval per 2 s per payment) across several instances; Redis `NX PX` is the cheapest cross-instance gate. Key prefix `payments:` is owned by this domain (I.4); TTL present (III.9).

**Alternatives**: in-process map — rejected (multi-instance); row lock — rejected (holds a connection during provider I/O).

### R-11 `clientSecret` and the payment method token are columns, cleared on final status

**Decision**: `Payment.clientSecret` (TEXT NULL, set only when `requiresAction`), `Payment.paymentMethodToken` (TEXT NULL, set at accept, cleared on any final status in the same transition update). The response mapper emits `clientSecret` only for the owner and only when `status='PENDING' AND requiresAction`. Logs use a redacting serializer key list (`clientSecret`, `paymentMethodId`, `paymentMethodToken`, `stripe_secret_key`) and the outbox payload builders construct fields explicitly (no `payload: params`).

**Rationale**: spec LOCAL decisions; AS-63; A16.

**Alternatives**: store secrets in Redis with TTL — rejected: the charge is retried over minutes and a Redis eviction would lose the instrument.

### R-12 Reads live in the domain; ownership is in the predicate

**Decision**: `PaymentQueryService` (application) + `PaymentReadRepository` (infra). `getForUser(id, userId)`: `WHERE id = $1 AND "userId" = $2`; list: `WHERE "userId" = $1 [AND "orderId" = $2] [AND status = $3] AND (createdAt, id) < ($c, $i) ORDER BY "createdAt" DESC, id DESC LIMIT n+1`; cursor = base64url JSON `{c, i}` signed with an HMAC of the user id (a tampered or foreign cursor → `400 invalid_cursor`). Non-UUID path id → `404 payment_not_found` without hitting the database. Index `(userId, createdAt DESC, id DESC)`; `(orderId)` unique.

**Rationale**: III.4, III.10, AS-57–AS-59; the old `bisOrder` join disappears (C7).

### R-13 Config and shutdown

**Decision**: `libs/common/config/payments-config.ts` (the pattern of `orders-config.ts`): every number a positive integer with the spec default, `stripe_secret_key` required, startup fails naming the key (AS-65). Graceful stop (AS-66): the charge worker registers with the S54 shutdown registry: stop consuming → wait for the in-flight provider call (≤ 8 s) → record → exit; a hard kill leaves a recorded attempt, which is `crash_recovery` on redelivery.

### R-14 Test seams and the shared Stripe client

**Decision**: the e2e kit `payments/testing/payments-app.ts` boots `PaymentModule` + `PaymentProcessorModule` with the production pipes/filter/prefix, the S01 session fixture, `RateLimitModule.forRoot()`, `FakeClock`, a scriptable `FakePaymentProvider` (call log, per-call delays/answers) bound to `PAYMENT_PROVIDER`, a realtime spy, and calls consumer/job handlers directly (as orders' kit does). `FakeClock` also drives the `CircuitBreaker` clock. Seeds for other specs use `payments/testing` fixture helpers (`seedPayment`, `seedPayableOrder`), which is the only place outside the domain that may touch `Payment` (test code, IX.6). `test/seeds/*` stop importing `PaymentModel` from the barrel and import the fixture models from `@app/domains/payments/testing`.

### R-15 What is deliberately not done here

- Partial refunds, disputes, provider-initiated refunds, operator refund endpoint (spec Scope).
- Billing charges (`billing-gateway.port.ts`) keep calling `StripeService.createPaymentIntent` (A28); that method stays on the thin client, minus the breaker and the `is_load_test` branch, so billing keeps compiling; billing's spec adopts the payments charge command (sibling bullet).
- Ledger tables, reconciliation jobs, payouts: S14/S15. The `HasMany(LedgerEntry)` on `Payment` and `BelongsTo(Payment)` on `LedgerEntry` are removed (D-17) and nothing else in those files changes.
- The web `PaymentStatus` type (W03) and the edge-be route removal are in scope only as stated in `gaps.md` section D: the edge-be route is deleted here; the web type is a sibling bullet.
