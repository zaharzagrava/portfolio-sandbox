---
id: buffered-data
title: Buffered data
kind: term
status: draft
aliases: [buffered work, buffered writes]
defined_for: S54-platform-toolkit
rules_hash: f040f229bf5e
---
# Buffered data
## Definition
Buffered data is work an app holds in memory and has not yet written to its destination. [The shutdown flush](shutdown-flush.md) pushes this data out before the app closes its [connection pools ↗](../sw-external-terms.md#connection-pool). In a worker, this happens after the [consumer](event-consumer.md) stops and before the pools close. The order matters because buffered data that is not flushed before exit is lost. That reason is design intent (not stated in the spec).

## Example
A worker with no HTTP server gets [SIGTERM ↗](../sw-external-terms.md#termination-signal). It stops the consumer and flushes its buffered data. Then it closes its pools and exits 0, with no HTTP steps.

## Known gaps
- The spec does not say what counts as buffered data, for example log lines, metric samples or pending writes.
- The spec does not say what happens to buffered data that has not been flushed when the [hard shutdown timeout](hard-shutdown-timeout.md) ends the process.
- Not confirmed in the code: which component owns each buffer and registers its flush as a shutdown task.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-29
- [event-consumer](event-consumer.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [shutdown-flush](shutdown-flush.md)
<!-- used-by:end -->
