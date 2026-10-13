---
id: shutdown-flush
title: Shutdown flush
kind: term
status: draft
aliases: [flush, flushes]
defined_for: S54-platform-toolkit
rules_hash: 8fb4f60a10e5
---
# Shutdown flush
## Definition
The shutdown flush is the step where an app pushes out data it is still holding in memory before it closes its [connection pools ↗](../sw-external-terms.md#connection-pool). In a worker, it runs after the [consumer](event-consumer.md) stops and before the pools close. Running it before the pools close means work that is still waiting to be written is not lost on exit. That reason is design intent (not stated in the spec).

## Example
A worker gets [SIGTERM ↗](../sw-external-terms.md#termination-signal). It stops the consumer, flushes, closes pools and [exits 0 ↗](../sw-external-terms.md#exit-code), with no HTTP steps.

## Known gaps
- The spec does not say what is flushed, for example logs, metrics or buffered writes.
- The spec does not say whether HTTP apps also flush, or what happens to the exit code if the flush fails.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-15
- [buffered-data](buffered-data.md)
- [event-consumer](event-consumer.md)
- [management-listener](management-listener.md)
- [shutdown-task](shutdown-task.md)
- [shutdown-tasks](shutdown-tasks.md)
- [write-behind-claim](write-behind-claim.md)
- [write-behind-reclaim-expired](write-behind-reclaim-expired.md)
<!-- used-by:end -->
