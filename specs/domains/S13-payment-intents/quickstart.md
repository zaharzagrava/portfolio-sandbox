# Quickstart: validating S13 — Payment Intents (domain `payments`)

Run from `packages/backend` unless stated. Use the condensed runner; open the full log it prints only when the summary is not enough.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, Kafka/SQS stand-ins); migrations applied by the harness (`pnpm test:stack:migrate`). Production deploy order: expand migrations (`20261011…payments-s13-*`) → worker with the `orders.events` consumer, caught up → core/payment-processor with the new route → (a later release) contract migration and topic retirement.
- Config (startup fails naming the key without them): `stripe_secret_key`, `PAYMENTS_CURSOR_SECRET` (≥ 32 bytes). Every other `PAYMENTS_*` key has the default of [contracts/services.md](contracts/services.md). Specs bind the scriptable `FakePaymentProvider` to `PAYMENT_PROVIDER`; no spec calls Stripe.
- S14 is not built: specs use the real `LedgerService.recordPaymentCaptured/recordPaymentRefunded` wrappers on the real ledger tables. S10 is built: order events are published as contract-valid fixtures from `packages/contracts`.

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/payments/domain                          # WP-2 unit: status table, amount rules (fast-check), outcome classifier, backoff
$S libs/domains/payments/payment-boundary                      # WP-1/WP-13: AS-64 (barrel, no association, ownership remainder, no cycle)
$S libs/domains/payments/payment-transitions                   # WP-3: AS-40…AS-43
$S libs/domains/payments/payment-order-events                  # WP-4: AS-44, AS-47, AS-48, AS-49
$S libs/domains/payments/payment-intent                        # WP-5: AS-01…AS-14
$S libs/domains/payments/payment-charge                        # WP-6: AS-15…AS-22
$S libs/domains/payments/payment-breaker                       # WP-7: AS-31…AS-38
$S libs/domains/payments/payment-unknown                       # WP-8: AS-23…AS-30
$S libs/domains/payments/payment-events                        # WP-9: AS-45, AS-46, AS-61
$S libs/domains/payments/payment-refund                        # WP-10: AS-50…AS-54
$S libs/domains/payments/payment-status-service                # WP-11: AS-55, AS-56
$S libs/domains/payments/payment-read                          # WP-12: AS-57…AS-60
$S libs/domains/payments/payment-ops                           # WP-12/14: AS-62, AS-63, AS-65, AS-66
```

Whole capability once at the end: `$S libs/domains/payments`, then the suites that import payments or depend on its seams and must stay green: `libs/domains/orders` (webhook, payment-events, checkout), `libs/domains/marketing`, `libs/infrastructure/rate-limit`, `libs/infrastructure/idempotency`, `libs/infrastructure/events`, `libs/infrastructure/projections`, and `finance.e2e-spec.ts` (kept; its resolver spy test moves to `payment-unknown`).

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && npx eslint libs/domains/payments libs/infrastructure/stripe
pnpm check:boundaries
pnpm check:table-ownership          # expect payments: 3 findings (ledger-entry User = S14, two Shop = S15); baseline was 7; record the output
pnpm check:module-graph             # no orders <-> payments cycle
pnpm check:no-wallclock             # no Date.now()/new Date() in payments domain/application/infra
pnpm check:model-registry
grep -rn "sequelize.transaction" libs/domains/payments   # expect exactly the 4 S14/S15 sites that carry "S54 T037 audit" (baseline 4)
(cd ../contracts && npx tsc --noEmit)
```

## Manual spot checks (local stack, provider in test mode)

1. `curl -i -X POST localhost:3000/api/payments/intents -H "Authorization: Bearer $T" -H 'Idempotency-Key: demo-pay-0001' -H 'content-type: application/json' -d '{"orderId":"<reserved order>","paymentMethodId":"pm_card_visa"}'` → `202`, `Location`; repeat → same body + `Idempotency-Replayed: true`.
2. `curl -i localhost:3000/api/payments/<paymentId> -H "Authorization: Bearer $T"` → `PENDING`, then `COMPLETED` once the processor ran; another user's token → `404`.
3. Stop the provider double: new payments still answer `202`; `circuit_breaker_open{breaker="create_intent"}` shows `1` after 10 failures; restart it → payments settle.

## Ops artifacts (success criteria no automated test proves)

These are **not verified**. Each has a row in [`specs/UNVERIFIED.md`](../../UNVERIFIED.md) with status `not run`.

| Criterion | What is not proven | How to run it |
|---|---|---|
| SC-001 | 200 repeated runs of 5 simultaneous requests with 0 double charges (the e2e runs 5 simultaneous once and the two-key race 50 times) | Loop `$S libs/domains/payments/payment-intent -t "concurrent duplicates"` and `-t "one payment per order"` 200 times on the VPS runner stack; every run must pass; record the count in the row. |
| SC-002 | 99% of requests and reads under 300 ms over a sustained run with the provider down (AS-37 proves one request and one read under 300 ms) | k6 script (written when the load-proof task runs): provider double stopped, 50 VUs mixing `POST /payments/intents` (distinct orders/keys) and `GET /payments/:id` for 5 minutes; read `http_req_duration` p99. |
| SC-006 (timing part) | a refund completes within 5 minutes of the command with a healthy provider (the e2e proves exactly-once refund and the state path, not wall-clock) | Publish `orders.refund_requested` for 100 completed payments against the sandbox provider; measure command-to-`REFUNDED` time; p100 must be < 5 min. |
| SC-009 | the buyer sees the final result within 5 s of the provider's answer on the real stack (outbox relay, realtime hub, SSE) | Browser/SSE probe: subscribe to `user:<id>`, trigger the sandbox provider's success, measure time to `payment.status COMPLETED`; also poll `GET`. |
| SC-010 (log part) | 0 secrets or card data in a 10,000-line log sample of the full flows (AS-63 searches sentinels in the logs of the flows it runs, not a 10,000-line sample) | Run the flows in a loop until 10,000 log lines are captured; grep for the provider secret, a sentinel `clientSecret`, the sentinel token; expect 0 hits. |
| SC-010 (ownership part) | `check:table-ownership --strict` shows 0 findings for the payment-intent files | The three remaining `payments` findings are in S14/S15 files; run `--strict` after those capabilities land. `payment-boundary.e2e-spec.ts` asserts that none of the three is in a payment-intent file. |
