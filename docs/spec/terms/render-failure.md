---
id: render-failure
title: Render failure
kind: term
status: draft
aliases: [fail the render]
defined_for: S28-notifications
rules_hash: ae33334bf268
---
# Render failure
## Definition
A render failure happens when a notification cannot be turned into its message text. Two causes are named: a [template variable](catalog-template.md) is missing, or a money amount is not a whole number of [minor units](minor-units.md). The failing request is [dead-lettered](dead-letter-topic.md) and nothing else happens: no [inbox item](inbox-item.md), no [delivery](delivery.md), no [realtime event](realtime-event.md). The other requests in the same batch carry on normally.

## Example
An event in a batch gives an amount of `12.5` (illustrative) where an integer like `1250` minor units is expected. That one request fails to render and is dead-lettered. The other requests in the batch still create their inbox items and deliveries.

## Known gaps
- The spec does not give the [dead-letter reason code](dead-letter-reason-code.md) for a render failure.
- The spec does not say whether a request that failed to render is ever retried automatically, or only through a manual [redrive](dead-letter-redrive.md).
- The spec does not say what a dead-letter record for a render failure contains. It does say that secrets must never appear in dead-letter records.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-56
- [catalog-template](catalog-template.md)
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [dead-letter-topic](dead-letter-topic.md)
- [delivery](delivery.md)
- [inbox-item](inbox-item.md)
- [minor-units](minor-units.md)
- [realtime-event](realtime-event.md)
<!-- used-by:end -->
