---
id: analytics-events-topic
title: analytics.events topic
kind: term
status: draft
aliases: [analytics.events]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# analytics.events topic
## Definition
`analytics.events` is the [event stream topic ↗](../sw-external-terms.md#kafka-topic) that carries buyer analytics events, such as product views and add-to-carts. Trending products reads it through the [consumer group](consumer-group.md) `discovery-trending-topk`. [Messages are keyed by `anonymous_id` ↗](../sw-external-terms.md#kafka-message). Design intent (not stated in the spec): this keeps one visitor's events on the same [partition ↗](../sw-external-terms.md#kafka-partition), which helps the [per-visitor cap](per-visitor-view-cap.md). The trending consumer counts only `product_view` and `add_to_cart`. It counts other event names as [`ignored`](consumer-outcomes.md), and it sends invalid messages to the [dead-letter path ↗](../sw-external-terms.md#dead-letter-queue) with a reason.

## Example
Illustrative message read by `TrendingConsumer`. All values are made up, and the exact field layout is not given in the spec:
```json
{ "event_id": "e-123", "name": "product_view", "anonymous_id": "v-42",
  "ts": "11:00:30", "received_at": "11:00:31" }
```
This adds a view of weight 1 to the product's 11:00 window. A `page_view` event with the same shape would change nothing and would count as `ignored`.

## Known gaps
- The spec does not say which service publishes to `analytics.events` or who owns the topic. Trending owns only its consumer group.
- The spec does not say what the full message schema is or where dead-lettered messages go.
- The spec does not say how many partitions the topic has. [Watermarks](watermark.md), [idle-partition handling](idle-partition.md) and [offset commits ↗](../sw-external-terms.md#kafka-offset-commit) all work per partition.

## Used by
<!-- used-by:start -->
- [add-to-cart-signal](add-to-cart-signal.md)
- [consumer-group](consumer-group.md)
- [idle-partition](idle-partition.md)
- [per-visitor-view-cap](per-visitor-view-cap.md)
- [received-at](received-at.md)
- [trending-events](trending-events.md)
- [trending-window](trending-window.md)
- [visitor](visitor.md)
- [watermark](watermark.md)
<!-- used-by:end -->
