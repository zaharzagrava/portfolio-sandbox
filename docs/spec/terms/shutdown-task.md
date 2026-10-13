---
id: shutdown-task
title: Shutdown task
kind: term
status: draft
aliases: [later tasks]
defined_for: S54-platform-toolkit
rules_hash: 9af7832c805a
---
# Shutdown task
## Definition
A shutdown task is one step of cleanup work that the [shutdown sequence](shutdown-sequence.md) runs after [HTTP requests have drained](graceful-shutdown-drain.md). Tasks run one after another in [ascending order](shutdown-tasks.md). If a task fails or times out, the later tasks still run, but the process exits with code 1 so the failure is visible.

## Example
In a worker, the shutdown steps are: stop the consumer, [flush](shutdown-flush.md), close [pools ↗](../sw-external-terms.md#connection-pool). If closing a pool timed out (illustrative), the remaining tasks would still run and the process would exit 1 instead of 0.

## Known gaps
- The spec does not say how a task is registered or what value decides its "ascending order".
- The spec does not say how long a single task may run before it counts as timed out.
- Not confirmed in the code: whether the worker steps (stop consumer, flush, close pools) are implemented as shutdown tasks or as fixed steps.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-30
- [S54](../capabilities/S54-platform-toolkit.md): B-12
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [shutdown-flush](shutdown-flush.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
<!-- used-by:end -->
