---
id: merge-cycle
title: Merge cycle
kind: term
status: draft
aliases: [cycle]
defined_for: S35-trending
rules_hash: 48225308dd83
---
# Merge cycle
## Definition
A merge cycle is one round in which the [consumer](event-consumer.md) tries to merge its [closed windows](trending-window.md) into the [aggregate store](aggregate-store.md). If the store fails, the merge is retried inside the same cycle with [backoff and jitter ↗](../sw-external-terms.md#exponential-backoff), up to a fixed number of attempts. [Offsets are committed ↗](../sw-external-terms.md#kafka-offset-commit) only up to the earliest unmerged window. So a failed cycle never commits a later offset, and the windows can still be merged later or [rebuilt after a crash](crash-recovery.md).

## Example
The aggregate store is down when the 11:42 window closes. The consumer tries the merge 3 times with growing, jittered delays, then gives up for this cycle. The committed offset stays before that window's first event.

## Known gaps
- The spec does not say what starts a cycle, how long a cycle lasts, or when the next cycle runs after all attempts fail.
- The spec does not give the backoff base or the maximum delay.
- The spec does not say whether the consumer keeps reading new events while a merge is failing.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-17
- [aggregate-store](aggregate-store.md)
- [crash-recovery](crash-recovery.md)
- [event-consumer](event-consumer.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
