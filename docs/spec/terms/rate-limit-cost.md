---
id: rate-limit-cost
title: Rate limit cost
kind: term
status: draft
aliases: [cost]
defined_for: rate-limit-policy
rules_hash: 9f68df4f9038
---
# Rate limit cost
## Definition
The rate limit cost is the number of budget units one call to [`check`](rate-limit-policy.md) takes from a [bucket](rate-limit-bucket.md). It must be a positive integer, otherwise `check` throws [`InvalidRateLimitCostError`](invalid-rate-limit-cost-error.md). A cost larger than the policy's `limit` can never be allowed, so it answers `422` [`rate_limit_cost_exceeded`](rate-limit-cost-exceeded.md) and not [`429` ↗](../sw-external-terms.md#http-429-too-many-requests). Design intent (not stated in the spec): waiting and retrying would never help, so a "try later" answer would be wrong.

## Example
Under a policy with `limit` 10 (illustrative), a cost of 3 takes 3 units. A cost of 11 answers `422` `rate_limit_cost_exceeded`. A cost of 0 or 2.5 makes `check` throw `InvalidRateLimitCostError`.

## Known gaps
- The spec does not say what the cost is when the caller does not pass one.
- The spec does not say which routes or code paths use a cost other than one unit.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-11
- [S50](../capabilities/S50-rate-limiter.md): B-08, B-09
- [batching-not-supported](batching-not-supported.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-cost-resolver](rate-limit-cost-resolver.md)
- [rate-limit-decorator](rate-limit-decorator.md)
- [sliding-window-estimate](sliding-window-estimate.md)
<!-- used-by:end -->
