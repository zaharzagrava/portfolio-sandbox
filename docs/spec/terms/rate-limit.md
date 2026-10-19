---
id: rate-limit
title: Rate limit
kind: term
status: draft
aliases: [limit, route's rate limit]
defined_for: idempotency-key
rules_hash: 0d6e608e0614
---
# Rate limit
## Definition
A rate limit caps how many requests a client may send to a route within a time window, and requests over the cap are rejected with `429`. It is enforced using [token bucket ↗](../sw-external-terms.md#token-bucket), [sliding window ↗](../sw-external-terms.md#sliding-window) and [concurrency limits](upstream-in-flight-limit.md), along with rules for what happens when the limiter itself is unavailable and response headers. A retry that carries the same [idempotency key](idempotency-key.md) still counts as a new request. The idempotency key prevents a second effect, but it does not make retries free. Design intent (not stated in the spec): this stops a client from using retries to get around the limit.

## Example
A route has a limit of 3 (illustrative). A client sends four identical requests with the same idempotency key:
```
request 1..3  -> accepted (one effect, via the idempotency key)
request 4     -> 429
```

## Known gaps
- The spec does not say which algorithm (token bucket, sliding window or concurrency limit) applies to which route, or the limit values for each route.
- The spec does not say what a limit is counted against (for example, per user, per IP or per API key).
- The spec does not say which rate-limit response headers are sent, or what each fail mode does when the limiter itself is unavailable.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-12
- [S10](../capabilities/S10-cart-checkout.md): R-09
- [S14](../capabilities/S14-ledger-reconciliation.md): R-27
- [S50](../capabilities/S50-rate-limiter.md): B-11
- [S51](../capabilities/S51-realtime-push.md): B-16
- [idempotency-key](../concepts/idempotency-key.md): C-07
- [rate-limit-policy](../concepts/rate-limit-policy.md): C-01
- [balance-controller](balance-controller.md)
- [blocked-host](blocked-host.md)
- [circuit-breaker-probe](circuit-breaker-probe.md)
- [concurrency-limit](concurrency-limit.md)
- [firewall-route](firewall-route.md)
- [get-cart](get-cart.md)
- [get-shop-balance](get-shop-balance.md)
- [idempotency-key-required](idempotency-key-required.md)
- [idempotency-key](idempotency-key.md)
- [invite-acceptance](invite-acceptance.md)
- [issue-already-resolved](issue-already-resolved.md)
- [key-set-forced-reload](key-set-forced-reload.md)
- [load-shedding](load-shedding.md)
- [login-throttle](login-throttle.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [mutating-route](mutating-route.md)
- [onboarding-submit](onboarding-submit.md)
- [post-auth-logout](post-auth-logout.md)
- [post-auth-refresh](post-auth-refresh.md)
- [post-auth-register](post-auth-register.md)
- [post-consumption-submit](post-consumption-submit.md)
- [post-csp-reports](post-csp-reports.md)
- [protected-route](protected-route.md)
- [put-cart-items](put-cart-items.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-exemption](rate-limit-exemption.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
- [rate-limit-response-headers](rate-limit-response-headers.md)
- [registration-duplicate-attempted-event](registration-duplicate-attempted-event.md)
- [request-throttle](request-throttle.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
<!-- used-by:end -->
