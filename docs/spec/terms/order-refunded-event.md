---
id: order-refunded-event
title: order.refunded event
kind: term
status: draft
aliases: [order.refunded]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# order.refunded event
## Definition
`order.refunded` is an order event published on the [orders topic](orders-events-topic.md) when an order is refunded. The [`OrderBasketsProjector`](order-baskets-projector.md) ignores it. It writes no [basket](basket.md), changes no existing basket and [dead-letters nothing ↗](../sw-external-terms.md#dead-letter-queue). Only [`order.paid`](order-paid-event.md) creates a basket.

## Example
An `order.refunded` event for an order whose `order.paid` event was already consumed arrives. The basket recorded for that order is left as it is (S34.B-12).

## Known gaps
- The spec does not say whether a refunded order's basket should still count toward [co-orders](co-occurrence-graph.md) in later builds. As written, it keeps counting until it falls outside the [build window](build-window.md).

## Used by
<!-- used-by:start -->
- [basket](basket.md)
- [build-window](build-window.md)
- [co-occurrence-graph](co-occurrence-graph.md)
- [orders-events-topic](orders-events-topic.md)
<!-- used-by:end -->
