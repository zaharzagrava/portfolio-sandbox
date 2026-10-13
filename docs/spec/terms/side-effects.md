---
id: side-effects
title: Side effects
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 80e7267623cb
---
# Side effects
## Definition
Side effects are the visible results of [routing a notification request](notification-routing.md). These include an [inbox item](inbox-item.md), [a delivery handed to a line](notification-delivery.md), a [realtime event](realtime-event.md) on `user:<userId>`, or a change to the [unread count](unread-count.md). A request that cannot be rendered must be [dead-lettered](dead-letter-topic.md) before it produces any of these. The other requests in the same [consumer batch](consumer-batch.md) carry on as normal.

## Example
A batch from the orders consumer holds three requests. One fails to render in the recipient's locale (illustrative cause). That request goes to the dead-letter topic with no inbox item, no [`notify-email`](notify-push.md) message and no `notification` event. The other two are routed as usual.

## Known gaps
- The spec does not list side effects for this rule. The list above comes from the effects named in S28.R-02 (inbox item, delivery, realtime event, count).
- The spec does not say what makes a request "cannot be rendered", for example a missing template, a missing locale or a bad payload field.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-04
- [consumer-batch](consumer-batch.md)
- [dead-letter-topic](dead-letter-topic.md)
- [inbox-item](inbox-item.md)
- [notification-delivery](notification-delivery.md)
- [notification-rendering](notification-rendering.md)
- [notification-routing](notification-routing.md)
- [realtime-event](realtime-event.md)
- [unread-count](unread-count.md)
<!-- used-by:end -->
