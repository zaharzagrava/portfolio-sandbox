---
id: shop-order-received-notification
title: shop.order_received notification
kind: term
status: draft
aliases: [shop.order_received]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# shop.order_received notification
## Definition
`shop.order_received` is a [notification type](notification-type.md) sent to the selling shop when a buyer pays an order. It reaches the shop owner as an [inbox item](inbox-item.md). The [`notification-router`](notification-router.md) [consumer group](consumer-group.md) derives it from events, and [replaying a topic](event-replay.md) must not duplicate it.

## Example
B-08: a buyer pays a [drop order](drop.md). The buyer has one [`order.confirmed`](order-confirmed-notification.md) item, and the shop owner has one `shop.order_received` item.

## Known gaps
- The spec does not say whether shop staff or admins also receive it. Only the owner is named.
- The spec does not say whether the owner gets one item per paid order or a grouped item. The rules confirm only "one" per order in B-08.

## Used by
<!-- used-by:start -->
- [consumer-group](consumer-group.md)
- [drop](drop.md)
- [event-replay](event-replay.md)
- [inbox-item](inbox-item.md)
- [notification-type](notification-type.md)
<!-- used-by:end -->
