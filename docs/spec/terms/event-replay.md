---
id: event-replay
title: Event replay
kind: term
status: draft
aliases: [replay]
defined_for: outbox-task-queue
rules_hash: bfeb89f6fa1c
---
# Event replay
## Definition
Replay is named in one part of the spec as something it defines, but the spec gives no rule for it. In general engineering, replay means reading past events again to rebuild or repair a [projection ↗](../sw-external-terms.md#projection). [Consumers](event-consumer.md) that in effect apply each event only once make reading events again safe, though this is design intent and the spec does not state it. Treat any detail beyond the name as unconfirmed.

## Example
Illustrative, not taken from the spec: [S32](../capabilities/S32-product-search.md)'s [search index](search-index.md) gets corrupted. Catalog events are read again from the start, and the index is rebuilt. Duplicate events are harmless because the consumer is [idempotent ↗](../sw-external-terms.md#idempotency).

## Known gaps
- The spec does not say how replay works: how it is triggered, where it starts, or whether it reads from Kafka or from the outbox table.
- The spec does not say how this term relates to projection-and-replay, which S32 cites.
- The spec does not say which consumers support replay.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-15
- [J02](../capabilities/J02-seller-to-first-sale.md): R-15
- [J03](../capabilities/J03-launch-day.md): R-14
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-12, B-19
- [S28](../capabilities/S28-notifications.md): B-03
- [S34](../capabilities/S34-recommendations.md): B-14
- [S35](../capabilities/S35-trending.md): R-20
- [S51](../capabilities/S51-realtime-push.md): R-07, R-08, B-04, B-12, B-15, B-18
- [projection-and-replay](../concepts/projection-and-replay.md): C-02
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-04, C-05
- [search-index](../concepts/search-index.md): C-08
- [auction-won-notice](auction-won-notice.md)
- [basket](basket.md)
- [billing-events-topic](billing-events-topic.md)
- [booking-confirmed-notification](booking-confirmed-notification.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [entitlement](entitlement.md)
- [event-consumer](event-consumer.md)
- [launch-events-events-topic](launch-events-events-topic.md)
- [live-events-topic](live-events-topic.md)
- [order-baskets-projector](order-baskets-projector.md)
- [order-confirmed-notification](order-confirmed-notification.md)
- [order-paid-event](order-paid-event.md)
- [parked-row](parked-row.md)
- [product-created-event](product-created-event.md)
- [published-row](published-row.md)
- [queue-pause](queue-pause.md)
- [queue-refusal](queue-refusal.md)
- [recent-comments](recent-comments.md)
- [replay-cursor](replay-cursor.md)
- [search-index](search-index.md)
- [shop-order-received-notification](shop-order-received-notification.md)
- [shop-rank](shop-rank.md)
- [stream-frame](stream-frame.md)
- [verification-failed](verification-failed.md)
- [voucher-command](voucher-command.md)
<!-- used-by:end -->
