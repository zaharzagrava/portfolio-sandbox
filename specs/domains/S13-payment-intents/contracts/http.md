# HTTP contract: S13 — `payments`

Base prefix `/api`. Schemas live in `packages/contracts/src/payments/` (new; `index.ts` re-exports; web and e2e specs import them, V.2). Every body is validated by the global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`); every error is `application/problem+json` `{type, title, status, detail, instance, requestId, code, …extensions}`; `5xx` `detail` is generic. All routes need an access token (`Firewall()`); a guest cookie never authenticates (`401`). Controllers call one application service (II.1).

## `POST /api/payments/intents`

| | |
|---|---|
| Auth | session user (`Firewall()`); `@RateLimit('payments.create.user')` — 10/min per user, fail **closed** |
| Headers | `Idempotency-Key` **required**, 8–128 chars `[A-Za-z0-9_-]`, via `@Idempotent()` (24 h, scope = principal) |
| Request | `createPaymentIntentRequestSchema` = `{ orderId: uuid, paymentMethodId: string(1..255) }`, strict (any other property → `400 validation_failed` naming it) |
| Success | `202`, `Location: /api/payments/<paymentId>`, body `paymentAcceptedSchema` = `{ paymentId: uuid, orderId: uuid, status: 'PENDING', amountMinor: int 1..99999999, currency: 'EUR'\|'USD'\|'GBP', createdAt: iso }` |
| Replay | same key + same body → the stored `202` body byte for byte + `Idempotency-Replayed: true` (and `Location`) |

Problem codes (all problem+json):

| Status | `code` | When |
|---|---|---|
| 400 | `validation_failed` | unknown/extra property (`amountMinor`, `currency`, `userId`, card fields…), bad `orderId`, missing/empty/long `paymentMethodId` |
| 401 | `unauthenticated` | no credentials or guest cookie |
| 404 | `order_not_found` | unknown order, another buyer's order, or no order copy within 2 s — byte-identical bodies apart from `instance`/`requestId` |
| 409 | `order_not_payable` + `reason` | `order_cancelled`, `order_paid`, `hold_expired` (`now >= reservedUntil`) |
| 409 | `payment_already_exists` + `existingPaymentId` | the order already has a payment, in any status |
| 409 | `idempotency_in_flight` (`Retry-After: 1`) | same key still running |
| 422 | `idempotency_key_required` / `idempotency_key_invalid` / `idempotency_key_reuse` | missing; malformed (short, 129 chars, space); same key other body |
| 422 | `amount_out_of_range` / `currency_unsupported` | order total outside 1..99,999,999; currency not EUR/USD/GBP |
| 429 | `rate_limited` (`Retry-After`) | 11th request in a minute; limiter store down |
| 503 | `service_unavailable` | database down (key released) |

Behaviour: validate → rate limit/idempotency → wait ≤ 2 s (outside any transaction) for the order copy → payable checks (pure) → amount/currency rules (pure) → one transaction: insert `Payment` (`ON CONFLICT ("orderId") DO NOTHING`; zero rows → `409 payment_already_exists`), `PaymentHistory(∅ → PENDING)`, outbox task `payments.charge_requested` → `202`. The provider is not called. Only the `202` is remembered; failures before a payment exists leave the key unused; a `5xx` releases it.

## `GET /api/payments/:paymentId`

| | |
|---|---|
| Auth | session user; `@RateLimit('payments.read.user')` — 120/min per user, fail **open** |
| Success | `200` `paymentSchema` = `{ id, orderId, status: 'PENDING'\|'UNKNOWN'\|'COMPLETED'\|'FAILED'\|'CANCELLED'\|'REFUND_PENDING'\|'REFUNDED', amountMinor, currency, failureCode: string\|null, requiresAction: boolean, clientSecret: string\|null, version: int, createdAt, updatedAt }` |
| `clientSecret` | non-null only for the owner while `status='PENDING' AND requiresAction` |
| Errors | `404 payment_not_found` (another buyer's payment, a missing one, and a non-UUID id: identical bodies), `401`, `429` |
| Safety | read only: no state change, no provider call (status refresh is the R1 service's, not this route's) |

## `GET /api/payments`

Query `paymentListQuerySchema`: `orderId?: uuid`, `status?: <one status>`, `limit?: int 1..100 (default 20)`, `cursor?: string`. Success `200` `paymentPageSchema` = `{ items: paymentSchema[] (clientSecret always null), nextCursor: string|null }`, ordered `createdAt DESC, id DESC`, scoped `WHERE "userId" = $caller` (a foreign `orderId` filter returns an empty page). `400 validation_failed` for `limit` 0/101 or bad `status`; `400 invalid_cursor` for a malformed/tampered/foreign cursor; `429` as above.

## Removed (breaking, no external clients)

`GET /payment/by-key/:idempotencyKey`, `GET /payment/:id`, `GET /payment`, the payment SSE stream `GET /payment/stream` (replaced by realtime `payment.status`), the Kafka topic `payments.requests`, and the gateway route in `packages/edge-be/src/index.ts` that wrote to it. `apps/core/src/payment-query/` and `apps/sse-gateway/src/payment-stream/` are deleted; their modules leave `core.module.ts`/the SSE gateway module.

## Rate-limit policies (declared in `payments/rate-limit-policies.ts`, registered with `RateLimitModule.forFeature`)

`payments.create.user` {slidingWindow, 10 / 60 s, key `user`, failMode `closed`}; `payments.read.user` {slidingWindow, 120 / 60 s, key `user`, failMode `open`}.

## Realtime

Topic `user:<userId>` (already registered by identity), event `payment.status`, data `{paymentId, orderId, status, version}`; published after commit through `RealtimePublisher`; failure is logged and counted (`payments_realtime_publish_failed_total`) and never affects the transition.
