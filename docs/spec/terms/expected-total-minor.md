---
id: expected-total-minor
title: expectedTotalMinor
kind: term
status: draft
aliases: []
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# expectedTotalMinor
## Definition
`expectedTotalMinor` is the order total the client showed the buyer, sent in the [checkout](post-checkout.md) request. It is in [minor units](minor-units.md). The server never uses it as the price. Checkout always reads prices, currency and shop from the [catalog](catalog-domain-layer.md). If the client value differs from the total the server calculates, checkout stops with [`price_changed`](price-changed.md). This makes sure the buyer never pays an amount they were not shown. That reason is design intent (not stated in the spec).

## Example
The client shows A × 2 at the old price and sends `"expectedTotalMinor": 2000`. A now costs 1200, so the server total is 2400 and checkout answers `409 price_changed`.

## Known gaps
- The spec does not say whether the field is required or optional.
- The spec does not say whether the order total or each [shop-order subtotal](shop-subtotal.md) is compared. The rule only says "the server total".

## Used by
<!-- used-by:start -->
- [catalog-domain-layer](catalog-domain-layer.md)
- [minor-units](minor-units.md)
- [post-checkout](post-checkout.md)
- [shop-subtotal](shop-subtotal.md)
<!-- used-by:end -->
