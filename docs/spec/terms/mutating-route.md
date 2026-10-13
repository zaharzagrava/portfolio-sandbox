---
id: mutating-route
title: Mutating route
kind: term
status: draft
aliases: [mutating routes]
defined_for: S50-rate-limiter
rules_hash: 923115d0f1f1
---
# Mutating route
## Definition
A mutating route is an HTTP route whose method is not a [safe method ↗](../sw-external-terms.md#safe-http-method), so it can change state. Examples are `POST`, `PUT`, `PATCH` and `DELETE`. Without [`@RateLimit`](rate-limit-decorator.md) or [`@RateLimitExempt`](rate-limit-exemption.md), it is limited by [`default.write`](default-rate-limit-policies.md) rather than `default.read`. [The idempotency check](idempotency-key.md) runs after [throttling](rate-limit.md), so replaying a request with the same Idempotency-Key still uses [budget](rate-limit-budget.md).

## Example
A route with an `Idempotency-Key` header is limited to 3 requests. The client sends the same request four times. The fourth gets `429` even though the idempotency layer would have replayed the stored answer.

## Known gaps
- Not confirmed in the code: which methods [`defaultEntryFor`](default-rate-limit-policies.md) treats as safe. The behavior (B-18) only names `GET`, so `HEAD` and `OPTIONS` are not confirmed.
- The spec does not give the limits of `default.write`.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-11
- [idempotency-key](idempotency-key.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit](rate-limit.md)
<!-- used-by:end -->
