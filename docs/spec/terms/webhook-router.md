---
id: webhook-router
title: Webhook router
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: 347ce20b27c4
---
# Webhook router
## Definition
The webhook router is the component that takes events for a shop and sends them to that shop's webhook endpoint. It is an [event consumer](event-consumer.md), so it can be [paused](partition-pause.md) and resumed like the other consumers in the journey. While it is paused, nothing reaches the receiver and no [fact](fact.md) is lost. When it resumes, each pending event is delivered once and its [consumer lag](consumer-lag.md) is visible. A paid order produces one signed `order.paid` per (order, shop), carrying only that shop's lines.

## Example
The test pauses the webhook router, and a buyer pays an order for the shop's product. The receiver `R` gets nothing. After the router resumes, `R` gets exactly one `order.paid` (J02 AS-28).

## Known gaps
- The spec does not say whether the router signs the deliveries or another component does.
- The spec does not name the router's [consumer group](consumer-group.md), the [topic ↗](../sw-external-terms.md#kafka-topic) it reads, or its source file.
- The spec does not say how the router behaves for events other than `order.paid` and `product.created`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
