---
id: hash-tag
title: Hash tag
kind: term
status: draft
aliases: [hash tags]
defined_for: S50-rate-limiter
rules_hash: ced276e4c55e
---
# Hash tag
## Definition
A hash tag is the shared part of a stored key that is built from the [policy](rate-limit-policy.md) and the [subject](rate-limit-subject.md). Every item that one [rate-limit decision](rate-limit-check.md) touches carries the same hash tag. A [clustered store](rate-limit-counter-store.md) places keys with the same hash tag on the same [shard ↗](../sw-external-terms.md#shard). That lets a single [atomic script ↗](../sw-external-terms.md#atomic-script) read and write all of a decision's items in one step. Design intent (not stated in the spec): without a shared hash tag, a multi-key script could not run atomically across shards.

## Example
In a [sliding-window](sliding-window-estimate.md) decision for policy `default.write`, the current-window and previous-window counters share one hash tag. Illustrative key shape (not taken from the code):
```
rl:{default.write:<subject>}:cur
rl:{default.write:<subject>}:prev
```

## Known gaps
- The spec does not say which store product or key format is used. The `{…}` brace syntax shown above is the Redis Cluster convention and is illustrative only.
- Not confirmed in the code: how `hashTag` in `policy-keys.ts` encodes a hashed subject, or whether it escapes characters.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-15
- [rate-limit-check](rate-limit-check.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rate-limit-subject](rate-limit-subject.md)
- [sliding-window-estimate](sliding-window-estimate.md)
<!-- used-by:end -->
