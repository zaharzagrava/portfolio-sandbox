# StripeCircuitOpen

**Severity:** page (SEV1 during business hours) · **Owner:** payments · **Dashboards:** *Payments*

## What it means
The circuit breaker around Stripe PaymentIntent creation is open: ≥ 50% of calls failed or timed out, so new payments fail fast instead of piling up. Checkout is blocked at the payment step.

## Triage (≤ 5 min)
1. Stripe status: https://status.stripe.com. Stripe API p95 panel (`server_address="api.stripe.com"`).
2. Our side? Logs `{service="payment-processor"} | json | level="error"`: auth errors (rotated key?), 400s (a code change sending bad params?), timeouts (network/NAT).
3. Deploy in the last hour?

## Mitigate
- **Stripe incident:** nothing to fix on our side. Keep orders RESERVED (holds expire after 15 min, SD-19), show the "payments temporarily unavailable" banner (a `payments.degraded` flag - create it in SD-38 admin if it does not exist yet), and communicate. Retries are safe: every charge uses Idempotency-Key = orderId.
- **Our bug / bad key:** roll back or rotate the key (Secrets Manager → restart).
- **Network:** check NAT gateway / VPC endpoints health.

## Verify
`circuit_breaker_open == 0` for 10 min; payment success rate back to baseline; no duplicate charges (idempotency keys guarantee it, but check the Stripe dashboard for the incident window).
