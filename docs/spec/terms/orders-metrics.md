---
id: orders-metrics
title: Orders metrics
kind: term
status: draft
aliases: [orders_checkout_total, orders_discount_fallback_total, orders_paid_after_cancel_total, orders_reservation_expired_total, orders_webhook_events_total]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# Orders metrics
## Definition
These are the [operational metrics ↗](../sw-external-terms.md#metrics) the orders domain publishes: `orders_checkout_total`, `orders_reservation_expired_total`, `orders_webhook_events_total`, `orders_discount_fallback_total` and `orders_paid_after_cancel_total`. Every one of them must have [bounded labels ↗](../sw-external-terms.md#metric-labels), meaning each label can only take a fixed, small set of values. Order IDs, buyer IDs and keys therefore never become label values. Per-order detail goes in the logs instead, which carry the order ID for checkout and webhook results.

## Example
A checkout that fails with [`out_of_stock`](out-of-stock-error.md) increments `orders_checkout_total` with a result-style label. The label shown here is illustrative:
```
orders_checkout_total{result="out_of_stock"} 1
```

## Known gaps
- The spec does not say which labels each metric has, or the exact event that increments each one. The names hint at their meaning but don't define it.
- The spec does not say what triggers `orders_discount_fallback_total` or `orders_paid_after_cancel_total`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
