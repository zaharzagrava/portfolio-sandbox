---
id: routing-step
title: Routing step
kind: term
status: draft
aliases: [routing]
defined_for: S28-notifications
rules_hash: fc5941641dce
---
# Routing step
## Definition
A routing step is one unit of [the router](notification-router.md)'s work for a recipient. Examples are creating the [inbox item](inbox-item.md), applying the [marketing cap](marketing-cap.md) and [quiet hours](quiet-hours.md), and handing a [delivery](delivery.md) to its [line](notification-channel.md). Each step must be safe to repeat after a crash at any point, so that a re-run reaches the same final state as one uninterrupted run. A "[done" marker](done-marker.md) may let a step be skipped, but the step itself must still guard against duplicates.

## Example
The router creates the inbox item for `u-42` (illustrative), then crashes before queuing the e-mail. The event is redelivered. The inbox step finds the existing item by its [dedupe identity](dedupe-identity.md) and creates nothing new. The e-mail step then queues the missing delivery on `notify-email`.

## Known gaps
- The spec does not list every routing step. Recipient resolution and rendering may or may not count as steps.
- The spec does not say what the done marker is or where it is stored.
- Not confirmed in the code: the guard each step uses to stay [idempotent ↗](../sw-external-terms.md#idempotency).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-03, R-09
- [dedupe-identity](dedupe-identity.md)
- [delivery](delivery.md)
- [done-marker](done-marker.md)
- [inbox-item](inbox-item.md)
- [marketing-cap](marketing-cap.md)
- [notification-channel](notification-channel.md)
- [notification-router](notification-router.md)
- [queue-refusal](queue-refusal.md)
- [quiet-hours](quiet-hours.md)
<!-- used-by:end -->
