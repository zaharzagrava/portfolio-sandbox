---
id: shutdown-tasks
title: Shutdown tasks
kind: term
status: draft
aliases: [tasks]
defined_for: S54-platform-toolkit
rules_hash: 70ffd404cadb
---
# Shutdown tasks
## Definition
Shutdown tasks are the cleanup steps that run at the end of [graceful shutdown ↗](../sw-external-terms.md#graceful-shutdown), once the requests already being handled have finished. They run one after another in ascending order. Examples are stopping a consumer, [flushing buffers](shutdown-flush.md) and closing pools. If a task fails or times out, the later tasks still run, but the process [exits with code 1](shutdown-sequence.md). If the overall time limit for shutdown runs out before the sequence ends, the process logs `forced shutdown` and exits with code 1.

## Example
A worker with no HTTP server receives [SIGTERM ↗](../sw-external-terms.md#termination-signal). It skips the HTTP steps, stops the consumer, flushes, closes its pools and exits 0. If the flush task had timed out, the pool-closing task would still have run and the exit code would be 1.

## Known gaps
- The spec does not say what value tasks are ordered by (for example a numeric priority) or how a task is registered.
- The spec does not say whether each task has its own timeout, or what that timeout would be.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-10
- [crash-handlers](crash-handlers.md)
- [create-graceful-shutdown](create-graceful-shutdown.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [in-flight-request](in-flight-request.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-flush](shutdown-flush.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-task](shutdown-task.md)
- [socket-destruction](socket-destruction.md)
<!-- used-by:end -->
