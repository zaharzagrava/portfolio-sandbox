---
id: order-confirmed-notification
title: order.confirmed notification
kind: term
status: draft
aliases: [order.confirmed]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# order.confirmed notification
## Definition
`order.confirmed` is a [notification type](notification-type.md). A buyer receives it as an [inbox item](inbox-item.md) after paying an order, including a [flash-sale drop order](drop.md). The [`notification-router` consumer group](consumer-group.md) creates it from events, so a [consumer outage](event-consumer.md) delays it but never blocks the purchase. Each payer gets exactly one item, even if [the topic is replayed](event-replay.md).

## Example
B-08: three buyers pay their drop orders (illustrative count). Each of the three has exactly one `order.confirmed` item in their inbox.

## Known gaps
- The spec does not say which event triggers it. The journey reads [`order.paid`](order-paid-event.md), but the link from that event to this notification is not confirmed.

## Used by
<!-- used-by:start -->
- [consumer-group](consumer-group.md)
- [drop](drop.md)
- [event-consumer](event-consumer.md)
- [event-replay](event-replay.md)
- [inbox-item](inbox-item.md)
- [notification-type](notification-type.md)
<!-- used-by:end -->
