# Quickstart: validating S10 — Cart, Checkout, Stock Reservation, Order State Machine, Payment Webhook

Run from `packages/backend` unless stated. Use the condensed runner; open the full log it prints only when the summary is not enough.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, DynamoDB Local with the `Carts` table, Kafka/SQS stand-ins); migrations applied by the test harness (`pnpm test:stack:migrate`). Deploy order in production: expand migrations → code → `orders.backfill-item-titles` to completion (`orders_backfill_orphans` = 0, no `title IS NULL`) → contract migration (a later release).
- Config (startup fails without them): `cart_cookie_secret` (≥ 32 bytes, not the JWT secret), `stripe_webhook_secret`; optional `stripe_webhook_secret_previous` during rotation. Other keys have the defaults of [contracts/services.md](contracts/services.md).
- S13 is not built: the worker binds `PaymentStatusUnavailableAdapter`; specs register a contract-valid fake of `PaymentStatusPort`. Until S13 binds the real adapter, live webhooks end `FAILED` (fail closed).

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/orders/domain                                   # WP-2 unit: state machine, money (fast-check), merge, token, signature, stock builder
$S libs/domains/orders/cart                                           # WP-3: AS-01…AS-10
$S libs/domains/orders/order-lifecycle                                # WP-5/8: AS-54…AS-57 (+AS-40, AS-55 cancel)
$S libs/domains/orders/checkout.e2e                                   # WP-6: AS-13…AS-28 (pricing, split, idempotency, lock)
$S libs/domains/orders/checkout-stock                                 # WP-7: AS-29…AS-40 (200/50 race, expiry, recovery, release)
$S libs/domains/orders/order-read                                     # WP-8: AS-58…AS-63 (history after VACUUM, seller list, exported reads)
$S libs/domains/orders/payment-webhook                                # WP-11: AS-41…AS-49, AS-51, AS-52
$S libs/domains/orders/payment-events                                 # WP-12: AS-50
$S libs/domains/orders/order-events                                   # WP-9: AS-64…AS-67
$S libs/domains/orders/orders-boundary                                # WP-13: AS-68 (entry point, models, transitional list)
```

Whole capability once at the end: `$S libs/domains/orders`, then the importer suites that must stay green: `libs/domains/{catalog-sync,auctions,notifications,experimentation,developer-platform,discovery,seller-insights,payments,shop-functions,asset-library}` and `libs/infrastructure/rate-limit`.

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && npx eslint libs/domains/orders
pnpm check:boundaries
pnpm check:table-ownership          # expect only the S12 remainder for orders (research D-1); record the output
pnpm check:no-wallclock             # no Date.now()/new Date() in application/domain/infra of orders
pnpm check:model-registry
grep -rn "sequelize.transaction\|S54 T037 audit" libs/domains/orders   # expect no match (baseline was 1)
(cd ../contracts && npx tsc --noEmit)
```

## Manual spot checks (local stack)

1. `curl -i localhost:3000/api/cart` → `200`, no `Set-Cookie`; `curl -i -X PUT .../cart/items/<uuid> -H 'content-type: application/json' -d '{"quantity":2}'` → one `Set-Cookie: cart=guest:…`.
2. Checkout twice with one key (`Idempotency-Key: demo-key-0001`) → first `202` + `Location`, second identical body + `Idempotency-Replayed: true`.
3. Post a Stripe test event signed with `stripe_webhook_secret` (`stripe trigger payment_intent.succeeded` with `orderId` metadata) → `200 {"received":true}` immediately; the order changes after the job runs.

## Ops artifacts (success criteria no automated test proves)

These are not verified. Each has a row in [`specs/UNVERIFIED.md`](../../UNVERIFIED.md) with status `not run`.

| Criterion | What is not proven | How to run it |
|---|---|---|
| SC-001 | 100% of **50 repeated** 200-buyers/50-unit races (the e2e runs the race 5 times) | Loop `$S libs/domains/orders/checkout-stock -t "no oversell under race"` 50 times against the VPS runner stack; every run must pass; record count in the row. |
| SC-003 | 99% of checkouts under 800 ms with 200 concurrent buyers | k6 script (`scripts/load/orders-checkout.js`, written when the load-proof task runs): 200 VUs, distinct keys, stock ≥ 200, read `http_req_duration` p99 for `POST /checkout`. |
| SC-004 (latency part) | 99% of cart operations under 50 ms | Same k6 harness, `GET /cart` and `PUT /cart/items/:id` at 500 req/s; the "zero relational access" half **is** proven by AS-01. |
| SC-005 (latency part) | 99% of genuine webhooks acknowledged under 1 s | k6 posting signed events at 100 req/s with the test secret; p99 of the `200`. Signature, tamper and duplicate behaviour **is** proven by AS-42, AS-43, AS-53. |
| SC-010 | `check:table-ownership --strict` shows 0 findings for `orders` | Run it after S12 replaces the `Product` join in `order-export.service.ts`; until then the output lists exactly that one remainder (AS-68 asserts every other finding is gone). |
