---
id: per-visitor-view-cap
title: Per-visitor view cap
kind: term
status: draft
aliases: [gains 1]
defined_for: S35-trending
rules_hash: f7b8df6a801a
---
# Per-visitor view cap
## Definition
The per-visitor cap stops one visitor from inflating a product's score inside a single one-minute window. Within one window, a visitor adds at most one view and at most one add-to-cart to each product. The cap resets at the next window, so steady interest across minutes still counts. It is implemented in `WindowCaps`.

## Example
One visitor sends 50 `product_view` events for product `A` within one window, and `A` gains 1. If the same visitor views `A` again in the next minute, `A` gains 1 more (S35.B-10).

## Known gaps
- The spec does not say which field identifies a visitor. The topic is keyed by `anonymous_id`, but no rule says the cap uses it.
- The spec mentions a 1% false-"seen" rate, which suggests a probabilistic check that can wrongly drop a first view. No test with its own id covers that rate.
- Not confirmed in the code: which data structure `WindowCaps` uses to track visitors it has already seen.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-10
- [add-to-cart-signal](add-to-cart-signal.md)
- [analytics-events-topic](analytics-events-topic.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-score](trending-score.md)
- [weighted-total](weighted-total.md)
<!-- used-by:end -->
