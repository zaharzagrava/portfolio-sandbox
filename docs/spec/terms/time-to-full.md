---
id: time-to-full
title: Time-to-full
kind: term
status: draft
aliases: [time to full]
defined_for: S50-rate-limiter
rules_hash: ced276e4c55e
---
# Time-to-full
## Definition
Time-to-full is how long a [token bucket ↗](../sw-external-terms.md#token-bucket) needs to refill to its capacity at the [policy's refill rate](rate-limit-policy.md). The limiter uses it to set the expiry of the [stored bucket item](rate-limit-counter-store.md), plus a small fixed margin. Once that time has passed, the bucket would be full anyway. Deleting the item therefore changes no decision, because a missing bucket starts full. Design intent (not stated in the spec): this keeps the store from holding items for [idle subjects](rate-limit-subject.md) forever.

## Example
Illustrative policy of 10 per 60 s, which refills one token every 6 s as in [B-02](behavior.md). An empty bucket has a time-to-full of 60 s, so its stored item expires after 61 s.

## Known gaps
- The spec does not say whether time-to-full is measured from the bucket's current level or from empty.
- Not confirmed in the code: whether the expiry is renewed on every decision or set only when the item is created.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-15
- [behavior](behavior.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
<!-- used-by:end -->
