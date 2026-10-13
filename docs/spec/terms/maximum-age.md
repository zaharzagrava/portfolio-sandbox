---
id: maximum-age
title: Maximum age
kind: term
status: draft
aliases: [max age]
defined_for: S28-notifications
rules_hash: 12de646e379d
---
# Maximum age
## Definition
The maximum age is a limit, set per [notification type](notification-family.md), on how old an event can be and still trigger an external delivery (e-mail, SMS or push). An event older than this produces no external delivery; its delivery is recorded [`expired`](pre-send-terminal-status.md). Its [inbox item](inbox-item.md) is still created. The age is checked at [routing time](notification-routing.md), again when a delivery delayed by [quiet hours](quiet-hours.md) wakes, and before every send. Design intent (not stated in the spec): a late message, such as an alert that has already passed, is useless or confusing on a phone. The inbox keeps the record.

## Example
A push for an auction event is held for quiet hours until 07:00 in the recipient's time zone (illustrative). When it wakes, the event is older than its type's maximum age. The push is recorded `expired` and never sent. The inbox item made at routing time is still there.

## Known gaps
- The spec does not give the maximum age of any notification type.
- The spec does not say what the age is measured from: the event's `ts`, the time it was published or the time it was consumed.
- The spec does not say whether the age check uses the injected clock, as quiet hours do.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-06
- [delivery-maximum-age](delivery-maximum-age.md)
- [delivery-timeline-expired](delivery-timeline-expired.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [notification-delivery](notification-delivery.md)
- [notification-family](notification-family.md)
- [notification-queue](notification-queue.md)
- [notification-routing](notification-routing.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-push](notify-marketing-push.md)
- [outbid-event](outbid-event.md)
- [quiet-hours](quiet-hours.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
