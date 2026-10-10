# Tasks: S13 — Payment Intents, Idempotency, Unknown Outcomes, PSP Circuit Breaker, Outbox, Saga with Orders (domain `payments`)

**Input**: [plan.md](plan.md), [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted), [data-model.md](data-model.md), [research.md](research.md), [contracts/](contracts/), [quickstart.md](quickstart.md). Constitution: `.specify/memory/constitution.md`.

**Tests**: required (test-plan.md has 66 rows). **Test-first**: inside every story the failing test task precedes the code task it proves; run the test, see it fail for the right reason, then implement.

## Conventions

- `D` = `packages/backend/libs/domains/payments`; `S` = `/opt/sdd/repo/scripts/sdd/test-spec.sh`. Run backend commands from `packages/backend`. Backend e2e: `$S <path-or-pattern> [jest args]` (condensed output; open the full log only if needed). Units: `npx jest libs/domains/payments/domain`.
- Run the narrowest test that proves the change; the whole capability once in the last phase. If the same test still fails after 5 fix attempts: stop, write the blocker, what was tried and the hypothesis into `questions.md`.
- Never use git checkout/restore/reset/stash/clean. To undo, edit by hand and keep every other change in the file.
- Transactions: `TransactionRunner.run` / `@Transactional` only; no new `sequelize.transaction` (baseline 4 sites, all S14/S15 files, `.tx.baseline`).
- Sibling specs are not edited: follow-ups go under `## Sibling-spec follow-ups` in `gaps.md` (already written by the plan; T073 re-checks them).
- Story order is by dependency, not number: US1 → US5 → US2 → US3 → US4 → US6 → US7 → US8 (US5 owns the transition service every other story uses).
- Format: `- [ ] Tnnn [P] [USn] description with path`. `[P]` = different files, no dependency on an unfinished task.

---

## Phase 1: Setup (WP-0, WP-1)

- [X] T001 Baseline. From `packages/backend`: run `pnpm check:table-ownership` and diff its `payments` lines against gaps.md section C (plan recorded 7 findings, nothing missing; append to `gaps.md` only if something differs); count `grep -rn "sequelize.transaction" libs/domains/payments` (expect 4, compare with `.tx.baseline` in this feature dir); run existing `D/payment.e2e-spec.ts`, `D/finance.e2e-spec.ts` and `libs/domains/orders` payment suites via `$S` to record what is green; note whether `enum_Payment_status` exists under that name (psql `\dT`). Write the results as a short "Baseline" paragraph at the end of `gaps.md`'s ownership section. (WP-0, A27, A29)
- [X] T002 [P] Throwaway probe (delete afterwards; done by reading the interceptor and by the specs that exercise it, see gaps.md "Notes from implementation pass 1"): confirm under Jest that the in-memory `TaskQueue`, a `FakeClock`-driven `CircuitBreaker` (`@app/common/resilience`) and the `@Idempotent()` header rules (8–128 `[A-Za-z0-9_-]`, `422` codes, 4xx-before-record not remembered) behave as `data-model.md`/`research.md` assume. If a rule differs, record it in `questions.md` instead of changing S54. (WP-0, A27)
- [X] T003 [P] Contracts: create `packages/contracts/src/payments/payment.ts` with `createPaymentIntentRequestSchema` (strict: `orderId` uuid, `paymentMethodId` string; unknown keys rejected), `paymentAcceptedSchema`, `paymentSchema` (no `idempotencyKey`, `providerRef`, `userId`; `clientSecret` nullable), `paymentPageSchema`, `paymentListQuerySchema` (`limit` 1…100 default 20, `cursor`, one `status`, `orderId`), status enum (`PENDING, UNKNOWN, COMPLETED, FAILED, CANCELLED, REFUND_PENDING, REFUNDED`), currency enum `EUR|USD|GBP`, failure-code enum (closed list from data-model.md) per `contracts/http.md`; export from `packages/contracts/src/payments/index.ts` and `src/index.ts`. (A19, A21)
- [X] T004 [P] Contracts: move `paymentEventSchemas` to `packages/contracts/src/payments/payment-events.ts`, additive within v1: `payment_failed.paymentRef` nullable, add `reasonCode` and `paymentVersion` to all three; make `packages/contracts/src/orders/payment-events.ts` re-export it so S10's `PaymentsEventsConsumer` still compiles. Run `(cd packages/contracts && npx tsc --noEmit)` and `$S libs/domains/orders -t payment` to prove S10 still passes. (S10 follow-up, A16)
- [X] T005 [P] Config: create `packages/backend/libs/common/config/payments-config.ts` with validated settings and the defaults of `contracts/services.md` (provider key `stripe_secret_key`, `PAYMENTS_CURSOR_SECRET` ≥ 32 bytes, timeouts 8/4/2 s + connect 2 s, breaker 10 s window / ≥ 10 calls / 50% / 30 s open / slow > 5 s, charge retry base 2 s cap 60 s ≤ 6 attempts ≤ 10 min, unknown backoff 30 s ×2 cap 15 min, 60-min no-record, 24-h stuck, sweep 60 s ≤ 200, refund due ≤ 100, refresh gate 2 s, order-copy wait 2 s); every non-positive limit or missing key fails startup naming the setting. (A30, AS-65)
- [X] T006 [P] Rate-limit policies: `D/rate-limit-policies.ts` with `definePolicies` for `payments.create.user` (10/min, fail closed) and `payments.read.user` (120/min, fail open). (A21)
- [X] T007 [P] Metrics: `D/domain/payment-metrics.ts` with the names/labels of AS-62 (`payments_*` counters/gauges incl. `payments_provider_mismatch_total{field}`, `payments_conflicting_provider_state_total`, `payments_completed_for_unpayable_order_total`, unknown/refund age gauges, `circuit_breaker_open{breaker}`). (A22)
- [X] T008 [P] Ownership registry: add `PaymentHistory: 'domain:payments'` and `PayableOrder: 'domain:payments'` to `packages/backend/db/ownership.ts`. (data-model)
- [X] T009 Boundary spec skeleton (fails first): `D/payment-boundary.e2e-spec.ts`, describe "Payments: domain boundaries" — asserts barrel `D/index.ts` has no `PaymentModel`/`PaymentStatus`/`PaymentDtoService`/`PaymentDtoModule`/`BalanceProjector`/`LedgerEntryModel`/`PayoutModel`; no `BelongsTo`/`HasMany`/`ForeignKey` to orders, users or ledger in `payment.model.ts`; no `@app/domains/orders` import in payments; no `Product` SQL; no `KafkaTopicGroup.payments`/`OutboxService.notify`/`KafkaConsumerService.consume` in payments; direct `sequelize.transaction` count in payments ≤ 4; the 3 remaining ownership findings are only S14/S15 files. Left red until T068. (AS-64)

**Checkpoint**: contracts compile, config/policies/metrics exist, boundary spec red.

---

## Phase 2: Foundational (WP-2) — blocks every story

- [X] T010 [P] Unit tests first (fail): `D/domain/payment-status.spec.ts` — 7 statuses × 7 commands (`succeed`, `fail(code)`, `markUnknown(reason)`, `awaitCustomer`, `cancel`, `requestRefund`, `refundSucceeded`) against the allowed list in data-model.md state machine; `awaitCustomer` keeps version; `cancel` only when `attempted === false`; terminals `FAILED|CANCELLED|REFUNDED`; `InvalidPaymentTransition {from, command}`; exhaustive-switch type test. (AS-39)
- [X] T011 [P] Unit tests first: `D/domain/payment-amount.spec.ts` — `it.each` boundaries (`0`, `1`, `99999999`, `100000000`, non-integer), currencies (`EUR`,`USD`,`GBP` ok; `JPY`,`BHD`, lowercase refused), one `fast-check` property (in-range accepted in each currency, outside refused). (AS-13)
- [X] T012 [P] Unit tests first: `D/domain/provider-outcome.spec.ts` — classification of every answer class (succeeded, card declines → `card_declined|insufficient_funds|expired_card|declined_other`, requires action, `400/401/403` → rejected, `429`/open breaker → not sent, `5xx`, timeout, reset, malformed → ambiguous) and field validation (amount, currency, status present, `orderId` metadata). (AS-22)
- [X] T013 [P] Unit tests first: `D/domain/backoff.spec.ts` — unknown delay ∈ `[0, min(15 min, 30 s × 2^n)]` for n = 0…20 with injected random 0 / 0.5 / 0.999…, cap respected, never negative; charge-retry delay ∈ `[0, min(60 s, 2 s × 2^n)]`; cut-off rule (6 attempts or 10 min since creation). (AS-27, AS-34)
- [X] T014 [P] Domain code in `D/domain/`: `payment-status.ts` (transition table, `assertNever`, `attempted` input), `payment-amount.ts` (integer 1…99,999,999; EUR/USD/GBP), `provider-outcome.ts` (classifier + validator), `backoff.ts` (full jitter, injected random), `order-copy.ts` (payable = `RESERVED` and `totalMinor` not null and `now < reservedUntil`; equal is expired), `failure-codes.ts`, `payment-errors.ts` (`AppError` subclasses with stable `code`s from `contracts/http.md`), `payment-cursor.ts` (signed opaque `(createdAt, id)` codec), `ports.ts` (tokens: `PAYMENT_REPOSITORY`, `PAYMENT_HISTORY_REPOSITORY`, `ORDER_COPY_REPOSITORY`, `PAYMENT_PROVIDER`, `LEDGER_POSTING`, `REALTIME_PUBLISHER_PORT`, `REFRESH_GATE`). No Nest/Sequelize/Stripe imports; `now` and `random` are parameters. Run `npx jest libs/domains/payments/domain` green. (D-6, A14, A24–A26)
- [X] T015 Migrations in `packages/backend/migrations/20261011…` with `SET lock_timeout = '3s'`: (1) `payments-s13-expand-columns.js` — add `orderId`, `currency` (default `'USD'`), `version` (INTEGER NOT NULL DEFAULT 1), `chargeAttemptedAt`, `chargeAttempts` (DEFAULT 0), `requiresAction` (DEFAULT false), `clientSecret`, `paymentMethodToken`, `failureCode` (CHECK closed list), `nextResolveAt`, `resolveChecks` (DEFAULT 0), `unknownSince`, `lastStuckAlertAt`, `refundRequestedAt`, `refundNextAt`; `CHECK (amount BETWEEN 1 AND 99999999)` and currency `IN ('EUR','USD','GBP')` as `NOT VALID`; make `idempotencyKey` nullable; drop `Payment_bisOrderId_fkey` if present. (2) `payments-s13-enum-refund-pending.js` — `ALTER TYPE "enum_Payment_status" ADD VALUE IF NOT EXISTS 'REFUND_PENDING'`, alone, `transaction: false`. (3) `payments-s13-expand-tables.js` — create `PaymentHistory` (columns/unique `(paymentId, version)` per data-model) and `PayableOrder` (`status` CHECK `IN ('RESERVED','PAID','CANCELLED')`). (4) `payments-s13-expand-indexes.js` — `CONCURRENTLY`, `transaction: false`: `Payment_orderId_key` unique partial, `Payment_providerRef_key` unique partial, `idx_payment_user_created (userId, createdAt DESC, id DESC)`, `idx_payment_unknown_due` partial, `idx_payment_refund_due` partial. (5) `payments-s13-backfill-validate.js` — copy `bisOrderId → orderId` (earliest row wins, log duplicates count), currency default, one synthetic history row per payment (`fromStatus NULL`, version 1, reason `backfill`, actor `system:migration`), then `VALIDATE CONSTRAINT`. No contract migration in this change. (E1–E3)
- [X] T016 Models (depends T015): edit `D/infra/models/payment.model.ts` — new columns, remove `@ForeignKey`/`@BelongsTo(BisOrder)`, the lazy `require('@app/domains/orders')` accessors, `HasMany(LedgerEntry)` and the `bisOrder*` scope/filters; create `D/infra/models/payment-history.model.ts`, `D/infra/models/payable-order.model.ts`; remove `BelongsTo(Payment)` from `D/infra/models/ledger-entry.model.ts` (plain `paymentId`, D-17 — leave its `User` association, S14's C4); amounts as `number` with safe-integer check at the repository edge. Run `pnpm check:model-registry`. (C3, D-11, D-17, III.8)
- [X] T017 [P] Repositories (`payment-read.repository.ts` waits for T055, US7) (depends T016) in `D/infra/`: `payment.repository.ts` (principal-scoped `findOwned(id, userId)`, conditional `transition` update `WHERE id AND status AND version`, `markAttempt`/`clearAttempt`, insert `ON CONFLICT ("orderId") DO NOTHING`), `payment-history.repository.ts` (`insert` + `listByPayment` only), `order-copy.repository.ts` (version-guarded upsert with `COALESCE` for cancelled), `payment-read.repository.ts` (keyset list, one statement ≤ 100). Bind to the port tokens. (D-6, A25)
- [X] T018 [P] Fake provider and e2e kit: `D/testing/fake-payment-provider.ts` (scriptable per call: answers, delays, timeouts, `5xx`, declines, customer-action, lookup and refund results, call log with timestamps), `D/testing/fixtures.ts` (`seedPayment`, `seedPayableOrder`, users from the S01 fixture), `D/testing/payments-app.ts` (boots `PaymentModule` + `PaymentProcessorModule` with production prefix, `ValidationPipe`, problem+json filter, `FakeClock`, realtime spy, forced limiter-store fault), `D/testing/index.ts` exporting models for `test/seeds`. (A23, A29)
- [X] T019 Provider adapter and thin client: `D/infra/stripe-payment-provider.adapter.ts` implementing `PAYMENT_PROVIDER` — four `CircuitBreaker`s (`create_intent`, `retrieve_intent`/lookup, `cancel_intent`, `refund`; 10 s window, ≥ 10 calls, 50%, 30 s open, one half-open probe, slow > 5 s counts, card declines and `4xx` do not count), per-operation timeouts, `maxNetworkRetries: 0`, lookup by `orderId` metadata through the SDK query builder (escaped), answer validation, returns classification input distinguishing "not sent" from "sent/ambiguous" (A9); edit `packages/backend/libs/infrastructure/stripe/stripe.service.ts` — remove the breaker from `createPaymentIntent` and all `is_load_test` branches, currency as parameter (no hard-coded `'usd'`), explicit timeout and zero SDK retries, add retrieve/search/cancel/refund-list helpers; keep `createPaymentIntent` compiling for `billing-gateway.port.ts` (A28). Bind `FakePaymentProvider` by DI for load-test env instead of branches. (A7, A9, A11, A12, A23, A24)
- [X] T020 [P] Ports adapters: `D/infra/redis-refresh-gate.ts` (`payments:refresh:<id>`, TTL 2 s, Redis timeout 100 ms), `D/infra/realtime.adapter.ts` (`RealtimePublisher`, 500 ms timeout, failure logged and counted never thrown), `D/infra/ledger-posting.adapter.ts` (calls `LedgerService.recordPaymentCaptured/Refunded`). (A15, A20)

**Checkpoint**: units green; `tsc --noEmit` on backend and contracts compiles; models free of foreign associations.

---

## Phase 3: User Story 1 — A buyer pays for a reserved order exactly once (P1) 🎯 MVP (WP-5)

**Goal**: `POST /payments/intents` accepts once per order, with idempotency, strict input, payable check and rate limit; no provider call on the path.

**Independent Test**: `$S libs/domains/payments/payment-intent` green (AS-01…AS-14).

### Tests first

- [X] T021 [US1] Write `D/payment-intent.e2e-spec.ts`, describe "Payment intents: accept, idempotency, validation and access", one `it` per row, all failing: AS-01 (`202` + `Location` + `paymentAcceptedSchema`, payment `PENDING` v1, history row, one `payments.charge_requested` outbox task, idempotency record, empty provider log); AS-02 (amount/currency from the order copy; `amountMinor`, `currency`, `userId`, card fields, unknown property → `400` naming it; bad `orderId`/`paymentMethodId` → `400`; nothing persisted); AS-03 replay (body byte for byte, `Idempotency-Replayed: true`); AS-04 in-flight gate → `409 idempotency_in_flight` + `Retry-After: 1`; AS-05 five identical `Promise.all`; AS-06 two keys ×50 → one `202`, one `409 payment_already_exists` + `existingPaymentId`, third key also `409` after `FAILED`; AS-07 (`422 idempotency_key_reuse|required|invalid`); AS-08 per-buyer keys; AS-09 key memory (fix-and-retry gives fresh `202`, `5xx` releases, `202` final for 24 h not after 24 h + 1 s); AS-10 (`401` anon and guest cookie; other buyer's order `404 order_not_found` byte-identical to unknown); AS-11 (`CANCELLED`, `PAID`, expired, `now == reservedUntil` → `409 order_not_payable` + `reason`); AS-12 (event at +1 s inside the 2 s wait → `202`; never → `404` after 2 s); AS-13 (`0`, `100000000` → `422 amount_out_of_range`; `JPY` → `422 currency_unsupported`); AS-14 (11th in a minute `429` + `Retry-After`; limiter store down → refused same way). Parse every body with the contracts schemas. Run it and confirm failures.

### Implementation

- [X] T022 [P] [US1] `D/application/order-copy.service.ts`: `upsert(event)` (version-guarded) and `waitForPayable(orderId, userId, deadline)` — polls up to 2 s outside any transaction; wrong owner and missing both end in the same `order_not_found`. Depends T017. (A5, AS-12)
- [X] T023 [US1] `D/application/payment-intent.service.ts`: reads order copy (outside tx), applies payable rule and `payment-amount` rule, then one `TransactionRunner.run` with three statements: payment insert (`ON CONFLICT ("orderId")` → `payment_already_exists` + existing id), history row (`∅ → PENDING`, actor `user:<id>`), `OutboxService.appendTask` `payments.charge_requested` `{paymentId, attempt: 0}` queue `payments-charge`; stores `paymentMethodToken`; amount/currency from the copy only; never reads `paymentIdempotencyKey`. No provider call. Depends T014, T017, T022. (A1–A3, A5, A7)
- [X] T024 [US1] Rewrite `D/api/payment.controller.ts` (new, thin) and `D/api/payment.dto.ts`: `POST /payments/intents` with `@Firewall()` (S01, user token only), `@Idempotent()`, `@RateLimit('payments.create.user')`, DTO class mapped to `createPaymentIntentRequestSchema`, `202` + `Location: /payments/<id>`; response mapped DTO (no model). Depends T023. (A1, A2, A21, A27)
- [X] T025 [US1] Run `$S libs/domains/payments/payment-intent` until green (AS-01…AS-14); fix code, not tests, unless the test contradicts spec.md.

**Checkpoint**: US1 independently green. MVP.

---

## Phase 4: User Story 5 — Competing paths agree: one change, one effect, recorded (P1) (WP-3)

**Goal**: `PaymentTransitionService.apply` is the single state writer.

**Independent Test**: `$S libs/domains/payments/payment-transitions` green (AS-40…AS-43) plus T010 units.

### Tests first

- [X] T026 [US5] Write `D/payment-transitions.e2e-spec.ts`, describe "Payments: guarded transitions and races", failing: AS-40 (resolution + refresh + late result ×50 → one `UNKNOWN → COMPLETED`, version +1, one history row, one journal, one event, one push, no caller error); AS-41 (`FAILED` + provider says succeeded → unchanged, error log with both states, `payments_conflicting_provider_state_total`; `COMPLETED` + late failed same); AS-42 (path `PENDING → UNKNOWN → COMPLETED → REFUND_PENDING → REFUNDED`, one history row each, version +1; `PaymentHistoryRepository` has no update/delete); AS-43 (`Promise.all` cancel vs charge start ×50 → exactly one outcome, never `CANCELLED` with a provider charge).
- [X] T027 [P] [US5] Event definitions test-first support: add `D/application/events/payment-events.ts` (`PaymentSucceeded|PaymentFailed|PaymentRefunded` via `defineEvent` on the contracts schemas; payloads built field by field, never `paymentMethodId`, `clientSecret`, provider objects, errors) and `D/application/events/order-events.ts` (consumer-side definitions on `orderEventSchemas`/`refundRequestedSchema`). Depends T004. (A16)
- [X] T028 [US5] Add `LedgerService.recordPaymentCaptured({paymentId,userId,amountMinor,currency}, tx)` and `recordPaymentRefunded({paymentId,amountMinor,currency}, tx)` in `D/application/ledger.service.ts` as thin wrappers over the existing posting (deterministic journal ids `uuidv5('sale:'+paymentId)` / `uuidv5('refund:'+paymentId)`, idempotent, shared account helper not `MERCHANT_${userId}`); write the **payment id** into `LedgerEntry.paymentId`. S14 owns the internals later. (A15, CONTRACT 8)
- [X] T029 [US5] `D/application/payment-transition.service.ts` `apply(paymentId, command, actor)`: one `TransactionRunner.run` — pure table check, conditional `UPDATE … WHERE id AND status = :from AND version = :v` asserting one row (zero rows = a lost race, re-read and return the winner's state, not an exception), history row, ledger call for `COMPLETED`/`REFUNDED`, outbox event for `COMPLETED|FAILED|CANCELLED|REFUNDED` (key `paymentId`), clear `clientSecret`/`paymentMethodToken` on final status; `afterCommit` push via `RealtimeAdapter` (`payment.status` to `user:<owner>`). No network I/O inside. Uses injected `Clock`. Depends T014, T017, T020, T027, T028. (A14, A15, A16, A20)
- [X] T030 [US5] Run `$S libs/domains/payments/payment-transitions` and `npx jest libs/domains/payments/domain` until green.

**Checkpoint**: single writer proven.

---

## Phase 5: User Story 2 — The charge happens in the background and every outcome is applied (P1) (WP-6)

**Goal**: charge command → one idempotent `charge()` with correct outcome handling.

**Independent Test**: `$S libs/domains/payments/payment-charge` green (AS-15…AS-22).

### Tests first

- [X] T031 [US2] Write `D/payment-charge.e2e-spec.ts`, describe "Payments: charge processing and outcomes", failing: AS-15 (one provider create with reference/key = `orderId`, metadata `orderId`, `eur`; `COMPLETED` v2, history, one balanced journal, one `payment_succeeded` with `amountMinor`/`currency` equal to the order copy, one push, `GET` shows `COMPLETED`); AS-16 decline (`FAILED(card_declined)`, no ledger, one event, no retry, breaker count unchanged); AS-17 customer action (stays `PENDING`, `requiresAction`, owner reads `clientSecret`, other buyer `404`, list has none; after refresh `COMPLETED`, secret null); AS-18 `400/401` → `FAILED(provider_rejected)`, error log with provider request id, no secret; AS-19 copy `CANCELLED` → `CANCELLED(order_not_payable)`, empty provider log, one `payment_failed`; AS-20 command twice (sequential and `Promise.all`) → one create, one transition, one event, four invalid payloads dead-lettered; AS-21 20 reads change nothing; AS-22 wrong amount/currency/missing status/wrong `orderId` metadata → `UNKNOWN(provider_response_invalid)`, no ledger/event, `payments_provider_mismatch_total{field}`, later lookup with same mismatch stays `UNKNOWN` and alerts.

### Implementation

- [X] T032 [US2] `D/application/payment-charge.service.ts` `charge(paymentId, attempt)`: read payment + order copy; if payment not `PENDING` or already attempted → no-op; copy not payable → `cancel`/`fail(order_not_payable)` through the transition service; conditional start mark (`chargeAttemptedAt IS NULL`, `chargeAttempts+1`, one statement, no transaction); provider call outside any transaction (key and metadata `orderId`, amount/currency from the copy, SDK retries 0); pure classification; one guarded transition per class: succeeded → `succeed` (+`providerRef`), decline → `fail(code)`, rejected → `fail(provider_rejected)`, requires action → `awaitCustomer` (store `clientSecret`, `requiresAction`), invalid answer → `markUnknown(provider_response_invalid)`; "not sent" clears the mark and schedules retry (US4). Depends T014, T019, T029. (A4, A8, A13)
- [X] T033 [US2] `D/infra/charge-command.worker.ts`: `TaskQueue.consume('payments-charge')` with `bodySchema` `{paymentId: uuid, attempt: int ≥ 0}` (invalid → DLQ `SCHEMA_INVALID`, next message processed), acknowledges stale commands, concurrency 20, calls `charge()`. Register in `D/payment-processor.module.ts` (new) with `D/infra/payment.jobs.ts` skeleton declaring `payments.charge`. Depends T032. (A4)
- [X] T034 [US2] Run `$S libs/domains/payments/payment-charge` until green.

**Checkpoint**: US1 + US5 + US2 deliver a full pay-and-settle path.

---

## Phase 6: User Story 3 — A silent provider never causes a second or a lost charge (P1) (WP-8)

**Goal**: timeout → `UNKNOWN`, resolved by lookup, never re-sent.

**Independent Test**: `$S libs/domains/payments/payment-unknown` green (AS-23…AS-30).

### Tests first

- [X] T035 [US3] Write `D/payment-unknown.e2e-spec.ts`, describe "Payments: unknown outcomes and resolution", failing: AS-23 (hang past 8 s → `UNKNOWN(provider_timeout)` v2, no ledger/event, first check +30 s, command acked, one create across redeliveries/restarts); AS-24 (lookup by `orderId` returns succeeded `pi_1` → `COMPLETED` via shared step, creates still 1); AS-25 (canceled / needs-payment-method → `FAILED` with code, no create); AS-26 (frozen clock +59 min 59 s stays and reschedules; +60 min since the **attempt** → `FAILED(no_provider_record)`); AS-27 (lookup timeout/failure/open breaker → stays `UNKNOWN`, next due inside jitter bounds; > 24 h hourly warning, gauge > 86,400, still `UNKNOWN`); AS-28 (customer action → `PENDING` + `requiresAction`, history `UNKNOWN → PENDING`); AS-29 (lost job → sweep resolves within 2 min of due; two sweepers → one lookup per payment); AS-30 (attempt recorded then forced stop → redelivery makes `UNKNOWN(crash_recovery)` without a second create; stop before attempt recorded → normal charge, one create). Move the resolver spy test from `finance.e2e-spec.ts:123-140` here.

### Implementation

- [X] T036 [US3] In `PaymentChargeService`: on timeout/ambiguous → `markUnknown(provider_timeout)` setting `unknownSince`, `nextResolveAt = now + 30 s`, enqueue `payments.resolve-unknown` job (in-transaction `JobsService.enqueue` allowed); on redelivery with `chargeAttemptedAt` set and status `PENDING` → `markUnknown(crash_recovery)`, never a second create. Depends T032. (A8)
- [X] T037 [US3] `D/application/payment-resolution.service.ts`: `resolve(paymentId)` — lookup by `orderId` metadata through the port (retrieve breaker, 4 s); found succeeded → `succeed`; canceled/failed → `fail(provider_canceled|decline code)`; customer action → `awaitCustomer` (`UNKNOWN → PENDING`); not found → `FAILED(no_provider_record)` only when `now − chargeAttemptedAt ≥ 60 min`, else reschedule; unreachable → reschedule with full jitter backoff `30 s ×2^resolveChecks` cap 15 min, increment `resolveChecks`; > 24 h since `unknownSince` → hourly warning (`lastStuckAlertAt`), gauge; mismatch stays `UNKNOWN` and alerts. Injected `Clock` and `random` (no `Date.now()`). (A10, A11, A26)
- [X] T038 [US3] `D/infra/payment.jobs.ts`: `@JobHandler` `payments.resolve-unknown` (per payment) and `payments.sweep-unknown` (every 60 s, `fleetConcurrency: 1`, `SELECT … WHERE status='UNKNOWN' AND nextResolveAt <= now ORDER BY nextResolveAt LIMIT 200 FOR UPDATE SKIP LOCKED`, one short transaction, enqueue resolves). Delete old `D/infra/payment-resolution.jobs.ts` registrations from `finance-worker.module.ts` (moved to the processor module). Depends T037. (A10, A11)
- [X] T039 [US3] Run `$S libs/domains/payments/payment-unknown` until green; then `$S libs/domains/payments/finance` to confirm the moved test left it green.

---

## Phase 7: User Story 4 — A provider outage degrades payments but not the platform (P1) (WP-7)

**Goal**: breaker, retry deadline, timeouts, HTTP independence.

**Independent Test**: `$S libs/domains/payments/payment-breaker` green (AS-31…AS-38).

### Tests first

- [X] T040 [US4] Write `D/payment-breaker.e2e-spec.ts`, describe "Payments: provider circuit breaker, timeouts and degradation", failing: AS-31 (10 `503`s → 10 `UNKNOWN`, breaker open, gauge `1`; 11th: no provider call, stays `PENDING`, retry scheduled, `POST` still `202`); AS-32 (+30 s one probe, concurrent calls refused, probe success closes / failure reopens 30 s; SC-003 ≤ 2 spy calls in 60 s); AS-33 (50 declines stay closed; 10 successful 6 s calls open it); AS-34 (recovery before attempt 3 → `COMPLETED`, one create, delays in bounds; 6 attempts or 10 min → `FAILED(provider_unavailable)`, zero creates, one event); AS-35 (SDK retry count 0, ≤ 6 attempts); AS-36 (hung provider ends at 8/4/2 s by operation; `GET` and another `POST` under 300 ms meanwhile; no transaction held); AS-37 (all breakers open → `POST` `202` and `GET` < 300 ms, readiness ready, liveness unaffected); AS-38 (separate breakers per operation).

### Implementation

- [X] T041 [US4] "Not sent" path in `PaymentChargeService`: breaker-open or `429` → `clearAttempt`, re-enqueue `payments.charge` job with full-jitter delay `[0, min(60 s, 2 s × 2^n)]`, max 6 attempts and 10 min since creation, then `fail(provider_unavailable)`; record `chargeAttempts`. Add `payments.charge` handler to `payment.jobs.ts`. Depends T032, T038. (A9, A13)
- [X] T042 [US4] Adapter touch-ups proven by the spec: gauge `circuit_breaker_open{breaker}` per operation, slow-call rule, probe single-flight, readiness check does not include breakers. Edit `D/infra/stripe-payment-provider.adapter.ts` and the probe registration only where the test shows a gap. (A9, A12, A22)
- [X] T043 [US4] Run `$S libs/domains/payments/payment-breaker` until green.

---

## Phase 8: User Story 6 — Payments and orders stay consistent (P1) (WP-4, WP-9, WP-10, WP-11)

**Goal**: order facts in, events out through the outbox, compensations both ways, R1 status export.

**Independent Test**: the five specs below green.

### Order facts and cancellation (AS-44, AS-47–AS-49)

- [X] T044 [US6] Write `D/payment-order-events.e2e-spec.ts`, describe "Payments: order facts and order-driven compensation", failing: AS-44 (`order.reserved` creates the copy; twice no change; stale `reserved` after `cancelled` v3 and `paid` v2 after v3 ignored; five invalid payloads dead-lettered; other `order.*` ignored); AS-47 (customer-pending: one provider cancel key `cancel:<paymentId>`, `CANCELLED(order_cancelled)`, one `payment_failed`; cancel timeout retried; provider says succeeded → `COMPLETED`); AS-48 (unattempted → `CANCELLED`, empty provider log, later charge command acked with no effect); AS-49 (running/unknown untouched; later `COMPLETED` emits `payment_succeeded` and increments `payments_completed_for_unpayable_order_total`).
- [X] T045 [US6] `D/infra/orders-events.consumer.ts` (S53 `Projector`, own group `payments-order-copy`, `ProjectionsModule.forProjectors`, idempotency `versionGuard`, zod via `orderEventSchemas`) → `OrderCopyService.upsert`; `order.cancelled` also calls `PaymentCancellationService`. `D/application/payment-cancellation.service.ts`: unattempted → `cancel` (guarded `chargeAttemptedAt IS NULL`); customer-pending (`requiresAction`) → enqueue `payments.cancel-intent` job; running/unknown untouched. Add `payments.cancel-intent` handler (provider cancel with `cancel` breaker, 4 s; "already succeeded" → `succeed`). Register in `PaymentProcessorModule`. (A5, A17)
- [X] T046 [US6] Run `$S libs/domains/payments/payment-order-events` until green.

### Events, outbox atomicity, push (AS-45, AS-46, AS-61)

- [X] T047 [US6] Write `D/payment-events.e2e-spec.ts`, describe "Payments: events, outbox atomicity and realtime", failing: AS-45 (forced ledger failure and forced abort → status, history, journal, outbox unchanged; stop between commit and relay → published once after resume with envelope and key `paymentId`; consumer twice → one effect; every event parses with `paymentEventSchemas` and with S10's `PaymentsEventsConsumer` definitions); AS-46 (accept leaves only an outbox row; call-log timestamps show no queue/provider call while a transaction is open); AS-61 (one `payment.status` to `user:<owner>` after commit and nobody else; hub down → transition and events unaffected, failure logged and counted).
- [X] T048 [US6] Make T047 pass: fix whatever it shows in `PaymentTransitionService`/`RealtimeAdapter`/`PaymentIntentService` (events only via `OutboxService.append/appendTask`; no `notify`). Run `$S libs/domains/payments/payment-events` until green. (A16, A20)

### Refunds (AS-50–AS-54)

- [X] T049 [US6] Write `D/payment-refund.e2e-spec.ts`, describe "Payments: refund commands", failing: AS-50 (`REFUND_PENDING` then `REFUNDED`, one provider refund `refund:<paymentId>`, one reversing journal in the status transaction, one `payment_refunded`, one push); AS-51 (five at once + later repeat → one transition/refund/journal/event; messages on `REFUND_PENDING|REFUNDED` acked); AS-52 (`UNKNOWN`/attempted `PENDING` → redelivered with backoff, then `COMPLETED` → refunded; `FAILED`/`CANCELLED` → "nothing to refund"; 24 h → dead letter + alert; unattempted `PENDING` → cancelled); AS-53 (six mismatch/invalid classes dead-lettered with reason metric, no effect, next processed); AS-54 (timeout → stays `REFUND_PENDING`, retry with lookup first, existing refund → `REFUNDED` with no second call; "already refunded" → `REFUNDED`; hard refusal or 24 h → stuck metric, error, gauge; open `refund` breaker → later, no call).
- [X] T050 [US6] `D/infra/refund-request.worker.ts` (`TaskQueue.consume('orders-refund-requested')`, `bodySchema` from `refundRequestedSchema`, mismatch of `amountMinor`/currency/owner → DLQ with reason), `D/application/refund-request.service.ts` (state table of `contracts/events.md`), `D/application/payment-refund.service.ts` (`requestRefund` → `REFUND_PENDING`, `payments.refund` job: lookup refunds first, then one refund with key `refund:<paymentId>`, `refundSucceeded` posts the reversing journal through `recordPaymentRefunded`, retry cap 15 min, 24-h window via `refundRequestedAt`/`refundNextAt`, sweep ≤ 100 due). Add `payments.refund` handler. (A17, S10 follow-up)
- [X] T051 [US6] Run `$S libs/domains/payments/payment-refund` until green.

### Status service, R1 (AS-55, AS-56)

- [X] T052 [US6] Write `D/payment-status-service.e2e-spec.ts`, describe "Payments: exported status service and provider refresh", failing: AS-55 (every status mapped per `contracts/services.md`; unknown/empty/256-char reference → `null`; result has no `clientSecret`, `userId`, failure detail, payment method); AS-56 (provider says succeeded → `COMPLETED` once; 10 concurrent callers → one transition and one retrieval per 2 s; provider down/timeout/open breaker → stored status, no throw; terminal → no provider call; `UNKNOWN` → same lookup as AS-24).
- [X] T053 [US6] `D/application/payment-query.service.ts` `getPaymentStatus(paymentRef)` (lookup by `providerRef`, Redis refresh gate, retrieval through the port, transition via the shared step, never throws on provider failure) exported from `D/index.ts`; create `libs/domains/orders/infra/payment-status.adapter.ts` (`PaymentQueryStatusAdapter` implements `PaymentStatusPort`) and bind it in `libs/domains/orders/orders-core.module.ts`. Run `$S libs/domains/payments/payment-status-service`, then `$S libs/domains/orders -t "webhook|payment"` until green. (A18, D-7, S10 follow-up)

**Checkpoint**: the saga with orders works both ways.

---

## Phase 9: User Story 7 — Buyers see their payments and nobody else's (P2) (WP-12)

**Goal**: `GET /payments/:id`, keyset `GET /payments`, tenant isolation.

**Independent Test**: `$S libs/domains/payments/payment-read` green (AS-57…AS-60).

- [ ] T054 [US7] Write `D/payment-read.e2e-spec.ts`, describe "Payments: reads, list and tenant isolation", failing: AS-57 (owner `200` `paymentSchema`; other buyer and missing id `404 payment_not_found` byte-identical; non-UUID `404`; `401`; `clientSecret` only for owner while `requiresAction`); AS-58 (45 payments → 20/20/5 with no repeat/skip under concurrent inserts, `nextCursor: null` at end, filters, bad `limit` `400`, tampered cursor `400 invalid_cursor`, default 20); AS-59 (`?orderId=` of another buyer's order → `200` empty; no filter leaks); AS-60 (121st read `429` + `Retry-After`; limiter store down → answered); plus the SC-007 matrix (every read/create route × other buyer × anonymous → identical `404`s/`401`, nothing changed).
- [ ] T055 [US7] Add `GET /payments/:paymentId` and `GET /payments` to `D/api/payment.controller.ts` (`@Firewall()`, `@RateLimit('payments.read.user')`, id validated as uuid else `404`), `D/application/payment-query.service.ts` `getOwned`/`list` using `PaymentReadRepository` (`WHERE id AND "userId"`, keyset on `(createdAt, id)` with signed cursor, `limit` ≤ 100, mapped DTO). Run `$S libs/domains/payments/payment-read` until green. (A19, A21, C7)

---

## Phase 10: User Story 8 — The domain is safe, observable and well-bounded (P3) (WP-12, WP-13)

**Goal**: observability, secrets, config, shutdown, and the boundary clean-up.

**Independent Test**: `$S libs/domains/payments/payment-ops` and `payment-boundary` green.

- [ ] T056 [US8] Write `D/payment-ops.e2e-spec.ts`, describe "Payments: observability, secrets, configuration and shutdown", failing: AS-62 (metrics exist and move over AS-15/16/23/31/50 flows; logs carry `requestId`/`traceId`, `paymentId`, `orderId`; one trace spans request, outbox row, processor); AS-63 (sentinel `paymentMethodId`, provider secret, `clientSecret` absent from logs, outbox payloads, events and error responses; `5xx` generic `detail`); AS-65 (boot with a missing provider key and with each non-positive limit → fails naming the setting); AS-66 (stop signal during a provider call → no new commands, call finishes within 8 s and is recorded, then exit; forced kill → AS-30 path).
- [ ] T057 [US8] Observability and redaction: structured logger fields (`paymentId`, `orderId`, `requestId`), redacting keys (`paymentMethodId`, `clientSecret`, provider secret, bodies), emit all AS-62 metrics from the services built so far, remove unused `Logger` instances. Wire `payments-config.ts` validation into `PaymentModule` and `PaymentProcessorModule` startup. (A22, A30)
- [ ] T058 [US8] Graceful shutdown: charge worker and jobs register an `onApplicationShutdown`/S54 shutdown task that stops taking commands and awaits in-flight provider calls (≤ 8 s); update `apps/payment-processor/src/payment-processor.module.ts` to import the new `PaymentProcessorModule`. (A31)
- [ ] T059 [US8] Run `$S libs/domains/payments/payment-ops` until green.

### Boundary clean-up (WP-13)

- [ ] T060 [US8] Delete old code: `D/application/payment.service.ts`, `D/infra/payment-dto.service.ts`, `D/infra/payment-resolution.jobs.ts`, `D/payment-dto.module.ts`, the old controller content (`@EventPattern('payments.requests')`), `D/payment.e2e-spec.ts` (replaced by the twelve new specs), `PaymentProcessed`/`PAYMENTS_AGGREGATE`, `KafkaConsumerModule`/`KafkaTopicGroup.payments.*`/`OutboxService.notify`/`KafkaConsumerService.consume` usage from `D/payment.module.ts`; remove the stock read/update SQL on `Product` and the stock-refund status path. Confirm `grep -rn "Product\b" D --include=*.ts` has no SQL hits. (A4, A6, A29, C1, C2, D-12, S05 follow-up, S53 follow-up)
- [ ] T061 [US8] Rewrite `D/payment.module.ts` (HTTP: controller, intent/query services, repositories, `ProjectionsModule` not here) and finish `D/payment-processor.module.ts` (charge worker, refund worker, jobs, `orders.events` consumer via `ProjectionsModule.forProjectors`, `PAYMENT_PROVIDER` bound to `StripePaymentProvider`, `FakePaymentProvider` in load-test env); rewire `apps/core/src/core.module.ts`, `apps/worker/src/worker.module.ts` and `finance-worker.module.ts` (drop `PaymentResolutionJobs`). (A23, A31, D-8)
- [ ] T062 [US8] Delete `apps/core/src/payment-query/*` and `apps/sse-gateway/src/payment-stream/*` (and their module imports in the SSE app module); remove the payments route (`payments.requests` write) from `packages/edge-be/src/index.ts:425-470`. (A19, A20, C7, edge gateway)
- [x] T063 [US8] Rewrite `D/index.ts`: export `PaymentModule`, `PaymentProcessorModule`, `PaymentQueryService` and the S14/S15 exports still used (`LedgerService`, `LedgerModule`, finance modules); drop `PaymentModel`, `PaymentStatus`, `PaymentDtoService`, `PaymentDtoModule`, `BalanceProjector`, `LedgerEntryModel`, `PayoutModel` from the barrel and fix every consumer in apps (`apps/*`, `libs/domains/marketing` keeps `LedgerService`/`LedgerModule`). (D-7, D-8, C10)
- [ ] T064 [US8] Orders side: remove `PaymentModel` import/injection from `libs/domains/orders/orders.module.ts` and `api/stripe-webhook.controller.ts` only if still present (S10 already removed the `HasMany(Payment)`; verify with grep and `payment-status.adapter` from T053), and make `libs/domains/orders/checkout.e2e-spec.ts` import nothing from payments models. Do not edit S10's spec. (D-7, D-11, C8)
- [ ] T065 [US8] `D/ledger.module.ts`: drop the `UserModel` and `BisOrderModel` registrations (both unused). `D/infra/settlement.listener.ts`: replace the `OrderPaid` import from the orders barrel with a local `defineEvent` built from the `packages/contracts` order-paid schema (still stores `paymentRef`; S14 decides the column). (C5, C9, D-11)
- [ ] T066 [US8] `libs/domains/billing/infra/billing-gateway.port.ts`: keep compiling against the thin Stripe client (`createPaymentIntent` retained, breaker and `is_load_test` removed); no behaviour change. (A28)
- [ ] T067 [US8] Replace imports in `packages/backend/test/seeds/*` and `test/utils/global-modules.ts` with `@app/domains/payments/testing`; adapt `D/finance.e2e-spec.ts` to the new fixtures. (A29)
- [ ] T068 [US8] Finish `D/payment-boundary.e2e-spec.ts` (T009) and run `$S libs/domains/payments/payment-boundary` until green; then `pnpm check:table-ownership` (expect `payments`: 3 findings — `ledger-entry.model.ts` `User`, `finance-worker.module.ts` and `payout.jobs.ts` `Shop`), `pnpm check:module-graph` (no `orders ↔ payments`; `payments` out of the strongly connected set), `pnpm check:boundaries`. (AS-64, D-6, D-7, D-11, D-12, D-15, D-17, C1–C9)

---

## Phase 11: Polish & whole-capability proof (WP-14)

- [ ] T069 Static gates from `packages/backend`: `npx tsc --noEmit -p tsconfig.json && npx eslint libs/domains/payments libs/infrastructure/stripe`; `(cd ../contracts && npx tsc --noEmit)`; `pnpm check:no-wallclock`; `pnpm check:model-registry`; `grep -rn "sequelize.transaction" libs/domains/payments` must equal 4 with all four carrying `// S54 T037 audit` (S14/S15 files, untouched).
- [ ] T070 [P] Whole payments suite once: `$S libs/domains/payments` and `npx jest libs/domains/payments/domain`; all twelve e2e files plus finance green.
- [ ] T071 [P] Dependent suites once: `$S libs/domains/orders`, `$S libs/domains/marketing`, `$S libs/infrastructure/rate-limit`, `$S libs/infrastructure/idempotency`, `$S libs/infrastructure/events`, `$S libs/infrastructure/projections`. If a failure comes from a sibling's assumption, do not edit that spec; add a bullet under `## Sibling-spec follow-ups` in `gaps.md`.
- [ ] T072 Unverified criteria (rule 2): confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-006 timing, SC-009, SC-010 log part and ownership part, and that `specs/UNVERIFIED.md` has exactly one row each for S13 (rows exist at lines 54-59; keep status `not run`, never write "verified"). SC-003, SC-004, SC-005, SC-007, SC-008 are proven by AS-32, AS-23/24/27/29, AS-40, the SC-007 matrix, AS-45.
- [ ] T073 [P] Sibling-spec follow-ups (rule 1): re-read `## Sibling-spec follow-ups` in `gaps.md` and confirm each bullet still matches what shipped (S10 no `getPayableOrder` and nullable `paymentRef`; S14 wrappers and `LedgerEntry.paymentId` meaning; S15; S53 legacy consume path deletion G-27; S54; S43/S46; billing S17; W03/S48 `PaymentStatus` type at `packages/web/lib/types.ts:98-104`; S28/S40; S11/S21). Add any new one found; do not edit other specs.
- [ ] T074 Record the green run (VII.9): append to `quickstart.md` a dated "Recorded run" with the counts/outputs of T069–T071 and the ownership result (7 → 3). Update `test-plan.md` only if a file name changed.
- [ ] T075 Final report: list every follow-up from S05, S10 (three entries) and S53 with where it was done and its proof (see table below), mention the deliberate divergence (no `getPayableOrder`, order copy instead), the ops artifacts left `not run`, and any blocker written to `questions.md`.

---

## Follow-up and gap traceability

| Requirement | Tasks |
|---|---|
| S05: price/stock via `getProductsByIds`/`applyStockDelta`; drop `ProductModel`; archived refuse | payments never reads price (amount = order copy: T022, T023) and never touches stock (T060); `ProductModel` import leaves with `payment.e2e-spec.ts` (T060, T067); `bis-order-item.model.ts` `BelongsTo(Product)` is S10's/orders' file: verified absent in T064 (if present, sibling bullet, not edited here) |
| S10: `PaymentStatusPort` via `getPaymentStatus` | T053 |
| S10: publish `payments.events` v1 with S10's payload; contracts file | T004, T027, T029, T031, T047–T048 |
| S10: `orderId` in metadata, key = `orderId`; `getPayableOrder`; stop reading `paymentIdempotencyKey` | T023, T032, T031 (AS-15); divergence recorded (order copy), T073 |
| S10: consume `orders.refund_requested` | T049–T051 |
| S10: drop `BisOrderModel` in `payment.model.ts`/`ledger.module.ts`; lazy accessors; `payment.e2e-spec.ts` | T016, T060, T064, T065, T068 |
| S10 (first pass): only `payments.payment_*`; amount/currency match; `OrderPaid.paymentRef`; settlement listener | T031, T047, T065, T028, T073 |
| S53: off `KafkaTopicGroup.payments.*`, `notify`, `consume` → `payments.events`/`appendTask` | T023, T029, T060, T068 |
| gaps A1–A3 | T021–T025 |
| A4, A8, A13 | T032, T033, T036 |
| A5 | T022, T023, T045 |
| A6, C1, C2, D-12 | T060 |
| A7 | T011, T014, T015, T019, T023 |
| A9, A12 | T019, T041, T042 |
| A10, A11, A26 | T037, T038 |
| A14, A15, A16 | T010, T014, T027–T029, T047–T048 |
| A17 | T045, T050 |
| A18, D-7 | T053, T063 |
| A19, A21, C7 | T003, T006, T024, T055, T062 |
| A20 | T029, T048, T062 |
| A22 | T007, T042, T057 |
| A23, A24, A25, D-6 | T014, T017, T018, T019, T061 |
| A27 | T002, T021 (AS-07, AS-09) |
| A28 | T066, T073 |
| A29 | T001, T018, T060, T067 |
| A30 | T005, T057 |
| A31 | T058 |
| B: D-8 | T063; D-11 | T016, T064, T065; D-15 | T068; D-17 | T016 |
| C3 | T016; C4 | S14 (T073 bullet); C5 | T065; C6 | S15 (T073); C8 | T064; C9 | T065; C10 | T063, T073 |
| D (contracts): S10, S14, S15, S53/49/50/51/54, S01, W03/S48, edge gateway | T004, T028, T024, T062, T073 |
| E migrations 1–3 | T015; E4 (retire topics) | later release, noted in T073 (S53 bullet) |
| S54 rule 4 (transactions) | T069 (count stays 4; `TransactionRunner.run` only in new code) |

## Dependencies & execution order

- Phase 1 → Phase 2 (blocks all) → US1 (Phase 3) → US5 (Phase 4) → US2 (Phase 5) → US3 (6) and US4 (7) (both extend `PaymentChargeService`; do US3 then US4 since T041 uses the jobs file from T038) → US6 (8) → US7 (9, can start after US1 + US5) → US8 (10, T060–T068 only after every story is green) → Polish (11).
- Parallel opportunities: T003–T008 together; T010–T013 together, then T014; T017/T018/T020 after T016; T022 with T027; test-writing tasks of different stories (T031, T035, T040, T044, T047, T049, T052, T054, T056) can be written in parallel with earlier stories' code because they are separate files, but must be seen failing before their code task; T070/T071 together.
- MVP: Phases 1–3 (US1) gives a safe accept path; the first payable increment is US1 + US5 + US2 (through T034).

## Notes

- Every test task is followed by the code task(s) it proves and a run-until-green task. Do not weaken tests to pass; if spec.md and a test disagree, fix the test and say so in the report.
- `D/index.ts` must keep exporting what `apps/*` and marketing still use until T063 updates each importer in the same task.

---

## Phase 12: Convergence

- [ ] T076 Add the `GET /payments/:paymentId` halves that `gaps.md` still lists as deferred but that are now buildable, since the route exists (gate repair, `PaymentController.getOne`): AS-15 (read shows `COMPLETED`), AS-17 (read shows the declined payment as `FAILED`), AS-36 and AS-37 (the `GET` answers under 300 ms next to a hung or all-open provider) in `payment-charge.e2e-spec.ts` and `payment-breaker.e2e-spec.ts`; then update the "Parts of P1 scenarios that need the read routes" row under `## Deferred until a later pass` in `gaps.md` to name only what still waits for US7 (the list route) per US2/AS-15, US2/AS-17, US4/AS-36, US4/AS-37 (partial)
