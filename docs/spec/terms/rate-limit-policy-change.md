---
id: rate-limit-policy-change
title: Rate limit policy change
kind: term
status: draft
aliases: [lowered policy, raised policy]
defined_for: S50-rate-limiter
rules_hash: 1e8704afc9e4
---
# Rate limit policy change
## Definition
A [policy](rate-limit-policy.md) change happens when a deployed policy's [`limit`](rate-limit.md) is lowered or raised while [buckets](rate-limit-bucket.md) stored under the old value still exist. If the limit is lowered, the next decision cuts the stored bucket down to the new capacity. If the limit is raised, the bucket does not fill up to the new capacity at once. It keeps its current level and refills from there. Design intent (not stated in the spec): raising a limit should not hand every subject a sudden burst of free requests.

## Example
A bucket on limit 10 holds 8 tokens and the limit is lowered to 5. The next [`check`](rate-limit-check.md) treats the bucket as holding 5. Later the limit is raised to 20 while the bucket holds 2. The bucket starts at 2 and refills over time instead of jumping to 20 (illustrative values).

## Known gaps
- The spec does not say whether a raised bucket refills at the new rate or the old rate. R-01 only says that the refill rate is tied to `limit`.
- The spec does not say what happens to [sliding-window counters ↗](../sw-external-terms.md#sliding-window) or [concurrency leases](concurrency-lease.md) when their policy changes. R-07 covers token buckets only.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-07
- [concurrency-lease](concurrency-lease.md)
- [rate-limit-bucket](rate-limit-bucket.md)
- [rate-limit-policy](rate-limit-policy.md)
<!-- used-by:end -->
