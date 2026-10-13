---
id: visitor
title: Visitor
kind: term
status: draft
aliases: [visitors]
defined_for: S35-trending
rules_hash: 942481460afa
---
# Visitor
## Definition
A visitor is the person behind a stream of [analytics events](analytics-events-topic.md). The [trending consumer](event-consumer.md) uses the visitor to cap how much one person can move the [ranking](trending-ranking-cache.md). In each [window](trending-window.md), one visitor adds at most one view and one [add-to-cart](add-to-cart-signal.md) to a product. The cap ([`WindowCaps`](per-visitor-view-cap.md)) can sometimes wrongly treat a new visitor as already seen, so a few real signals may be lost.

## Example
One visitor sends 50 views of product `A` in one window. `A` gains 1 point. In the next minute the same visitor views `A` again, and `A` gains 1 more point ([S35 B-10](behavior.md)).

## Known gaps
- Not confirmed in the code: that the visitor identity is the [`anonymous_id`](x-anonymous-id.md) used as the key on `analytics.events`. The facts give only the topic key.
- The spec does not say what happens to the visitor identity when a buyer signs in during a window.
- The visitor cap's false-"seen" rate has no test with its own id.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-18
- [W01](../capabilities/W01-auth-account.md): B-21
- [add-to-cart-signal](add-to-cart-signal.md)
- [analytics-events-topic](analytics-events-topic.md)
- [behavior](behavior.md)
- [event-consumer](event-consumer.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
