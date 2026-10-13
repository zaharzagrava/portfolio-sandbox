---
id: rate-limit-cost-exceeded
title: rate_limit_cost_exceeded
kind: term
status: draft
aliases: []
defined_for: rate-limit-policy
rules_hash: e3b0c44298fc
---
# rate_limit_cost_exceeded
## Definition
`rate_limit_cost_exceeded` is the error code the limiter returns when one request asks for a [`cost`](rate-limit-cost.md) larger than the [policy](rate-limit-policy.md)'s whole [`limit`](rate-limit.md). A full [budget](rate-limit-bucket.md) could never admit that request, so it is refused with `422` and not `429`. Design intent (not stated in the spec): a `429` tells the client to wait and retry, but waiting can never help here. A `cost` that is not a positive integer is a different case. [`check`](rate-limit-check.md) throws [`InvalidRateLimitCostError`](invalid-rate-limit-cost-error.md) for that, which is a programming error and not a client answer.

## Example
A policy has `limit: 120` and a caller runs `check` with `cost: 200` (illustrative values). The response is `422` with code `rate_limit_cost_exceeded`. With `cost: 0` or `cost: 1.5`, `check` throws `InvalidRateLimitCostError` instead.

## Known gaps
- The spec does not say which capabilities pass a `cost` other than the default, or what that default is.
- The spec does not say whether this response carries [`Retry-After` ↗](../sw-external-terms.md#retry-after) or the [rate-limit response headers](rate-limit-response-headers.md).
- The spec does not say whether the rejected request still uses up any budget.

## Used by
<!-- used-by:start -->
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-response-headers](rate-limit-response-headers.md)
<!-- used-by:end -->
