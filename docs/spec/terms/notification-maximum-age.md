---
id: notification-maximum-age
title: Notification maximum age
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e8ce3c7d4d1a
---
# Notification maximum age
## Definition
Each notification type has a maximum age. An event older than this limit must not reach anyone through e-mail, SMS or push. Its delivery is recorded as [`expired`](delivery-timeline-expired.md) on the [timeline](delivery-timeline.md), but its [inbox item](inbox-item.md) is still created. The worker checks the age when routing, when a delayed delivery wakes up and again just before each send.

## Example
A push notification is held for [quiet hours](quiet-hours.md) and wakes up with [`notifications.wake-delivery`](notifications-wake-delivery-job.md) the next morning. By then the event is older than the maximum age for its type. The push is not sent, the timeline shows `expired`, and the inbox item stays.

## Known gaps
- The spec does not say the maximum age of any type, or where those values are set.
- The spec does not say which time the age is measured from. It could be the event timestamp or the time the event was received.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-36, R-50
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [quiet-hours](quiet-hours.md)
<!-- used-by:end -->
