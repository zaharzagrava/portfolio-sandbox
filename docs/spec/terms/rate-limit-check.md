---
id: rate-limit-check
title: check (rate limit check)
kind: term
status: draft
aliases: [check]
defined_for: rate-limit-policy
rules_hash: f2e17602c94b
---
# check (rate limit check)
## Definition
`check` is the limiter call that asks whether a [subject](rate-limit-subject.md) may spend a cost from its [bucket](rate-limit-bucket.md) under one [policy](rate-limit-policy.md). It first validates the cost and throws [`InvalidRateLimitCostError`](invalid-rate-limit-cost-error.md) if the cost is not a positive integer. A cost larger than the policy's limit gets `422` [`rate_limit_cost_exceeded`](rate-limit-cost-exceeded.md). Otherwise the decision is one atomic step in the counter store, timed only by the store clock. A denial becomes `429` with `Retry-After`. If the store fails, the policy's fail mode decides what happens.

## Example
Policy `discovery.search.query` allows 120 searches per minute per user or address. A 121st search in the same minute is denied:
```
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 12        (illustrative value)
```
Calling `check` with `cost` `0` or `1.5` throws `InvalidRateLimitCostError` (illustrative values).

## Known gaps
- The spec does not give the signature or return shape of `check`, such as its argument names or what an admitted result contains.
- The spec does not say whether `cost` is optional or what its default is.
- Not confirmed in the code: whether `check` itself builds the `429`, `422` and `503` answers, or returns a decision that another layer such as the problem exception filter turns into a response.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): B-15, B-17
- [hash-tag](hash-tag.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [retry-after-ms](retry-after-ms.md)
<!-- used-by:end -->
