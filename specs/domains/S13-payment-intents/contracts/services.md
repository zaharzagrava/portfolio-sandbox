# Service contracts (R1) and ports: S13 — `payments`

## Exported from `@app/domains/payments` (public entry point, X.4)

| Export | Kind | Consumers |
|---|---|---|
| `PaymentModule` (core: HTTP + R1), `PaymentProcessorModule` (payment-processor, worker: consumers, jobs, charge worker) | Nest modules | apps |
| `PaymentQueryService` with `getPaymentStatus(paymentRef)` | R1 provider | S10 (webhook confirmation) |
| type `PaymentStatusView` | DTO type | S10 adapter |
| `PaymentSucceeded`, `PaymentFailed`, `PaymentRefunded` | event definitions | consumers (S10 already defines its own on the same schemas) |
| `paymentsRatePolicies` | policy table | rate-limit specs, global modules |
| `LedgerModule`, `LedgerService`, `LedgerEntryModel`, `PayoutModel`, `LEDGER_ACCOUNTS`, `shopAccount`, `CreateLedgerEntryDto`, `SystemAccount`, `LedgerAccountId`, `FinanceModule`, `FinanceWorkerModule`, `BalanceProjector` | **not S13's** (S14/S15): unchanged; `LedgerService` gains `recordPaymentCaptured`/`recordPaymentRefunded` | marketing, apps |

**Removed from the barrel** (D-7, D-8, AS-64): `PaymentModel`, `PaymentStatus`, `PaymentDtoService`, `PaymentDtoModule`, `CreatePaymentDto`, `PaymentProcessed`, `PAYMENTS_AGGREGATE`. Importers adapted in the same change: `test/seeds/*` (use `@app/domains/payments/testing`), `test/utils/global-modules.ts`, `apps/core/src/payment-query/*` (deleted), `apps/sse-gateway/src/payment-stream/*` (deleted), `orders` (`stripe-webhook.controller.ts`, `orders.module.ts`, `bis-order.model.ts` association, `order-payment` leftovers, `checkout.e2e-spec.ts` — S10 already stopped injecting `PaymentModel` in code; WP-13 verifies and removes any remnant), `marketing` (`LedgerModule`, `LedgerService` — unchanged), `apps/projector` (`BalanceProjector` — unchanged).

## `PaymentQueryService.getPaymentStatus(paymentRef: string)`

```ts
type PaymentStatusView = {
  paymentId: string;
  paymentRef: string;
  orderId: string;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  amountMinor: number;
  currency: 'EUR' | 'USD' | 'GBP';
};
getPaymentStatus(paymentRef: string): Promise<PaymentStatusView | null>;
```

- `null` for an unknown, empty or > 255-character reference (no database call for the latter two).
- Lookup `WHERE "providerRef" = $1` (unique partial index). Mapping: `PENDING→PENDING`, `UNKNOWN→PENDING`, `COMPLETED→COMPLETED`, `REFUND_PENDING→COMPLETED`, `REFUNDED→REFUNDED`, `FAILED→FAILED`, `CANCELLED→FAILED`.
- **Refresh** for non-terminal payments (`PENDING`, `UNKNOWN`): Redis gate `payments:refresh:<paymentId>` `SET NX PX 2000`; winner → provider `retrieveIntent` (breaker `retrieve_intent`, 2 s, no retry) → `PaymentTransitionService.apply` (same guarded step as AS-15) → returns the new mapped status; losers and any provider/Redis trouble → stored status; **never throws** for provider trouble; terminal → no provider call; `UNKNOWN` → the lookup of AS-24 instead of `retrieve`.
- Never returns `clientSecret`, `userId`, failure details, payment method.
- Consumer adapter (S10 side, shipped by WP-13): `orders/infra/payment-status.adapter.ts` gains `PaymentQueryStatusAdapter implements PaymentStatusPort` mapping the view to S10's `PaymentStatus` (a `null` view, meaning the payment is not known yet, throws S10's retryable `PaymentStatusUnavailableError`) and binding `PAYMENT_STATUS` to it in `orders-core.module.ts`.

## Internal ports (`domain/ports.ts`; tokens exported from `domain/`)

| Port (token) | Adapter (`infra/`) | Notes |
|---|---|---|
| `PAYMENT_REPOSITORY` | `PaymentRepository` (Sequelize, `Payment`) | `insertAccepted`, `startCharge`, `clearChargeMark`, `transition` (conditional update, returns row count), `findForUser`, `listForUser`, `findByProviderRef`, `findDueUnknown(limit)`, `findDueRefund(limit)`; no method that updates by id alone |
| `PAYMENT_HISTORY_REPOSITORY` | `PaymentHistoryRepository` | `insert`, `listByPayment`; no update/delete |
| `ORDER_COPY_REPOSITORY` | `OrderCopyRepository` | `upsertVersioned`, `find(orderId)` |
| `PAYMENT_PROVIDER` | `StripePaymentProvider` (production), `FakePaymentProvider` (`testing/`, load-test environment) | `createIntent({paymentId, orderId, amountMinor, currency, paymentMethodToken, referenceKey})`, `retrieveIntent(intentId)`, `findIntentByReference(orderId)`, `cancelIntent(intentId, key)`, `createRefund({intentId, key})`, `findRefunds(intentId)` → `ProviderResult` union; four breakers inside; `maxNetworkRetries: 0` |
| `LEDGER_POSTING` | `LedgerPostingAdapter` → `LedgerService.recordPaymentCaptured / recordPaymentRefunded` | called inside the transition transaction only |
| `REALTIME_PORT` | `RealtimeAdapter` → `RealtimePublisher` | called from `afterCommit`; errors caught, logged, counted |
| `REFRESH_GATE` | `RedisRefreshGate` | `SET NX PX` |
| `CLOCK`, `RANDOM` | platform clock; `Math.random` wrapper (injectable for backoff tests) | time and jitter never read directly in `domain/` |

## Application services

`PaymentIntentService.accept(user, body)` · `PaymentChargeService.charge(paymentId, attempt)` · `PaymentTransitionService.apply(paymentId, command, ctx)` (single state writer) · `PaymentResolutionService.resolve(paymentId)` / `sweepDue()` · `PaymentCancellationService.onOrderCancelled(orderId)` / `cancelIntent(paymentId)` · `PaymentRefundService.start(paymentId)` / `execute(paymentId)` · `RefundRequestService.handle(message)` · `OrderCopyService.apply(event)` · `PaymentQueryService` (reads + R1).

## Job types (S49; `declareJobType` with zod payload schemas, handlers in `infra/payment.jobs.ts`)

| Type | Payload | Options |
|---|---|---|
| `payments.charge` | `{paymentId, attempt}` | `maxAttempts: 1` (the use case owns the retry rule; failures reschedule explicitly), runAt = jittered delay |
| `payments.resolve-unknown` | `{paymentId}` | idempotency key `resolve:<paymentId>:<resolveChecks>` |
| `payments.sweep-unknown` | `{}` | schedule every 60 s, `fleetConcurrency: 1` |
| `payments.refund` | `{paymentId}` | idempotency key `refund:<paymentId>:<n>`; 24 h cap from `refundRequestedAt` |
| `payments.cancel-intent` | `{paymentId}` | backoff, until the provider answers |

## Configuration (`payments-config.ts`; env name → default; every number a positive integer, startup fails naming the key)

`stripe_secret_key` (required); `PAYMENTS_CREATE_TIMEOUT_MS` 8000; `PAYMENTS_REFUND_TIMEOUT_MS` 8000; `PAYMENTS_LOOKUP_TIMEOUT_MS` 4000; `PAYMENTS_CANCEL_TIMEOUT_MS` 4000; `PAYMENTS_REFRESH_TIMEOUT_MS` 2000; `PAYMENTS_CONNECT_TIMEOUT_MS` 2000; `PAYMENTS_BREAKER_WINDOW_MS` 10000; `PAYMENTS_BREAKER_MIN_CALLS` 10; `PAYMENTS_BREAKER_FAILURE_PCT` 50; `PAYMENTS_BREAKER_OPEN_MS` 30000; `PAYMENTS_BREAKER_SLOW_MS` 5000; `PAYMENTS_CHARGE_MAX_ATTEMPTS` 6; `PAYMENTS_CHARGE_DEADLINE_SECONDS` 600; `PAYMENTS_CHARGE_BACKOFF_BASE_MS` 2000; `PAYMENTS_CHARGE_BACKOFF_CAP_MS` 60000; `PAYMENTS_RESOLVE_FIRST_DELAY_MS` 30000; `PAYMENTS_RESOLVE_BACKOFF_CAP_MS` 900000; `PAYMENTS_RESOLVE_NO_RECORD_SECONDS` 3600; `PAYMENTS_STUCK_SECONDS` 86400; `PAYMENTS_SWEEP_INTERVAL_SECONDS` 60; `PAYMENTS_REFUND_BACKOFF_CAP_MS` 900000; `PAYMENTS_REFUND_WINDOW_SECONDS` 86400; `PAYMENTS_ORDER_COPY_WAIT_MS` 2000; `PAYMENTS_REFRESH_MIN_INTERVAL_MS` 2000; `PAYMENTS_PAGE_DEFAULT` 20; `PAYMENTS_PAGE_MAX` 100; `PAYMENTS_CURSOR_SECRET` (≥ 32 bytes). Rate-limit numbers live in the policy table.

## Metrics (names fixed by AS-62)

`payments_created_total{result}`, `payments_status_transitions_total{from,to}`, `payments_provider_calls_total{operation,outcome}`, `payments_unknown_outcomes_total`, `payments_unknown_oldest_age_seconds`, `circuit_breaker_open{breaker}`, `payments_refund_pending_oldest_age_seconds`, `payments_consumer_dead_lettered_total{reason}`, plus `payments_provider_mismatch_total{field}`, `payments_conflicting_provider_state_total`, `payments_completed_for_unpayable_order_total`, `payments_refund_stuck_total`, `payments_refund_requests_total{result}`, `payments_realtime_publish_failed_total`. Gauges for oldest ages are computed by the sweep job (`min(createdAt)`-style statements on the partial indexes), not per request.
