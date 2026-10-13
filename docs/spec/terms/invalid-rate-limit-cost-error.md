---
id: invalid-rate-limit-cost-error
title: InvalidRateLimitCostError
kind: term
status: draft
aliases: []
defined_for: rate-limit-policy
rules_hash: e3b0c44298fc
---
# InvalidRateLimitCostError
## Definition
`InvalidRateLimitCostError` is the error [`check`](rate-limit-check.md) throws when it gets a [`cost`](rate-limit-cost.md) that is not a positive integer, such as zero, a negative number or a fraction. It is thrown before any [bucket](rate-limit-bucket.md) is touched. Design intent (not stated in the spec): it signals a bug in the calling code, not a bad client request. A cost that is valid but larger than the [`limit`](rate-limit.md) is a different case and answers `422` [`rate_limit_cost_exceeded`](rate-limit-cost-exceeded.md).

## Example
Calling `check` with `cost` `0`, `-1` or `1.5` throws `InvalidRateLimitCostError` (illustrative values).

## Known gaps
- The spec does not say which HTTP status this error becomes if it reaches the [problem exception filter](problem-exception-filter.md).
- Not confirmed in the code: whether this error sends a request to the [fail-open or fail-closed ↗](../sw-external-terms.md#fail-open-fail-closed) path.

## Used by
<!-- used-by:start -->
- [problem-exception-filter](problem-exception-filter.md)
- [rate-limit-bucket](rate-limit-bucket.md)
<!-- used-by:end -->
