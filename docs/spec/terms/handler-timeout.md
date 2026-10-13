---
id: handler-timeout
title: Handler timeout
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Handler timeout
## Definition
The handler timeout is the longest time a consumer's handler is allowed to spend on one event. It is part of this capability's consumer configuration, next to the [consumer attempt budget](consumer-attempt-budget) and the [concurrency cap](concurrency-limit.md). Like the rest of that configuration, it is checked at [startup](startup-validation).

## Example
The [S53 configuration](../capabilities/S53-events-projections.md) lists the handler timeout as 30 s and the [consumer attempt budget](consumer-attempt-budget.md) as 3. If a handler for a `fixtures.item_changed` event (illustrative) were still running after 30 s, it would be over its handler timeout.

## Known gaps
- The spec does not say what happens when a handler runs past the timeout. For example, it does not say whether the run counts as a failed attempt, whether it counts as a [permanent error](permanent-error), or whether it leads to [`HANDLER_FAILED`](handler-failed.md).
- The spec does not say whether the timeout covers only the handler code or also the writes to the [sink](event-sink).
- The spec does not state the handler timeout in any rule or behavior. It appears only in the configuration list.

## Used by
<!-- used-by:start -->
- [concurrency-limit](concurrency-limit.md)
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [permanent-error](permanent-error.md)
<!-- used-by:end -->
