---
id: done-marker
title: Done marker
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 663b1d065e08
---
# Done marker
## Definition
The done marker is a record that a routing step has finished for a notification. On a retry, the [router](notification-router.md) can read it and skip the work it already did. It is only a shortcut. Each step must also be [safe to repeat ↗](../sw-external-terms.md#idempotency) by itself, so a retry without the marker still ends in the same state. The step uses the notification's [dedupe identity](dedupe-identity.md) so it does not create a second [inbox item](inbox-item.md), delivery, [realtime event](realtime-event.md) or count. Design intent (not stated in the spec): a crash can happen after a step's effect but before its marker is written, so the marker alone cannot prevent duplicates.

## Example
The router creates the inbox item for an `order.paid` event, then crashes before it writes the done marker. On retry it runs the step again. The dedupe identity (source event id, recipient, channel) finds the existing item, so no second item or bell increment appears.

## Known gaps
- The spec does not say where the done marker is stored, or whether it is kept per event, per recipient or per step.
- The spec does not say how long done markers are kept.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-03
- [dedupe-identity](dedupe-identity.md)
- [inbox-item](inbox-item.md)
- [notification-router](notification-router.md)
- [realtime-event](realtime-event.md)
- [routing-step](routing-step.md)
<!-- used-by:end -->
