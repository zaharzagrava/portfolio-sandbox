---
id: delivery-timeline-expired
title: Delivery timeline expired
kind: term
status: draft
aliases: [timeline]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Delivery timeline expired
## Definition
`expired` is a status on a [delivery's timeline](delivery-timeline.md). It means the delivery was never handed to a [provider](mail-provider.md) because its event was older than the [maximum age](maximum-age.md) of its type. It can be set at [routing time](notification-routing.md), when a [delayed delivery](delivery-status.md) wakes, or in the worker's check before sending. It is not a failure: no provider was called and no retry follows. The recipient's [inbox item](inbox-item.md) is not affected.

## Example
Timeline of an SMS delivery held for quiet hours (illustrative):
```
delayed  -> 23:10 (quiet hours, wake at 07:00)
expired  -> 07:00 (event older than its type's maximum age)
```

## Known gaps
- The spec does not say whether `expired` is final, or whether a delivery recorded `expired` at routing time first gets a `queued` entry.
- The spec does not say whether `expired` deliveries are counted in a metric.

## Used by
<!-- used-by:start -->
- [delivery-status](delivery-status.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [mail-provider](mail-provider.md)
- [maximum-age](maximum-age.md)
- [notification-routing](notification-routing.md)
<!-- used-by:end -->
