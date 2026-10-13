---
id: default-rate-limit-policies
title: Default rate limit policies
kind: term
status: draft
aliases: [default policy, default.write]
defined_for: S50-rate-limiter
rules_hash: 02c1dcf410a1
---
# Default rate limit policies
## Definition
`default.read` and `default.write` are the policies used for any route that has neither [`@RateLimit`](rate-limit-decorator.md) nor [`@RateLimitExempt`](rate-limit-exemption.md). [Safe methods ↗](../sw-external-terms.md#safe-http-method) use `default.read` and all other methods use `default.write`. [S50](../capabilities/S50-rate-limiter.md) owns these two policies. Every other policy belongs to the [capability](capability.md) that declares it. As a result, no route is left without a limit by mistake.

## Example
A route with no decorator gets `GET /…` limited by `default.read`. A `POST` to the same path is limited by `default.write`. The choice is made in `packages/backend/libs/infrastructure/rate-limit/default-rate-limit.ts#defaultEntryFor`.

## Known gaps
- The spec does not give the limit, window, algorithm, subject or [fail mode](rate-limit-fail-mode.md) of either default policy.
- The spec does not say which methods count as safe. The entry point says "safe methods", but behavior B-18 tests only `GET`, so `HEAD` and `OPTIONS` are not confirmed.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [http-surface](http-surface.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [rate-limit-exemption](rate-limit-exemption.md)
- [rate-limit-fail-mode](rate-limit-fail-mode.md)
<!-- used-by:end -->
