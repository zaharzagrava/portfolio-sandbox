---
id: realtime-store
title: Realtime store
kind: term
status: draft
aliases: [store fault]
defined_for: realtime-topic-stream
rules_hash: 2968a3625e4f
---
# Realtime store
## Definition
The realtime store is the store that [`publish`](realtime-publish.md) writes events to. The rules name it only through its failure modes: a fault, or an answer that takes too long. In either case `publish` gives up and resolves without an id. The [replay buffer](replay-buffer.md) keeps "stored events" per [topic](realtime-topic.md), and replay reads them. The spec does not confirm whether that buffer lives in this same store.

## Example
S13 publishes `payment.status`. The store is down, so `publish` resolves `{ published: false, id: null }` after one attempt. The payment transition goes ahead unchanged.

## Known gaps
- The spec does not say which technology the store is, or whether it is the same thing as the [backplane](realtime-backplane.md) that instances subscribe to.
- The spec does not say that the replay buffer is held in this store, although the "stored events" wording suggests it.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-20, R-32, B-13
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-06
- [realtime-backplane](realtime-backplane.md)
- [realtime-publish-limit](realtime-publish-limit.md)
- [realtime-publish](realtime-publish.md)
- [realtime-topic](realtime-topic.md)
- [replay-buffer](replay-buffer.md)
<!-- used-by:end -->
