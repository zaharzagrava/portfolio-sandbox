---
id: cache-invalidate-channel
title: cache:invalidate channel
kind: term
status: draft
aliases: [cache:invalidate]
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# cache:invalidate channel
## Definition
`cache:invalidate` is the pub/sub channel the [cache toolkit](cache-toolkit.md) owns for [L1 invalidation](l1-cache.md). Every instance subscribes to it. When one instance calls [`invalidate`](invalidate.md), it deletes the keys from [L2](l2-cache.md) and announces them on this channel. Each other instance then drops its own L1 copy of those keys. This keeps instances consistent without sharing their per-process copies.

## Example
Instance B holds `K` in L1. Instance A calls `invalidate([K])`, which resolves `{l2: 'ok', deleted: 1}`.
The message on `cache:invalidate` makes B drop `K`, and B loads the new value within 1 s.

## Known gaps
- The spec does not say what a message on the channel contains (full keys, key digests, or something else), or how keys are grouped into messages.
- The spec does not say whether a message can be lost while a subscription looks open. If one is lost, the only limit on serving the stale L1 copy is [`l1TtlMs`](l1-ttl-ms.md).
- The spec does not say whether the instance that calls `invalidate` also acts on its own message, or just evicts its local L1 copy directly.

## Used by
<!-- used-by:start -->
- [cache-broadcast-subscription](cache-broadcast-subscription.md)
- [cache-store-round-trip](cache-store-round-trip.md)
- [cache-toolkit](cache-toolkit.md)
- [invalidation-broadcast](invalidation-broadcast.md)
- [l1-cache](l1-cache.md)
- [l2-cache](l2-cache.md)
<!-- used-by:end -->
