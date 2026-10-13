---
id: price-changed
title: price_changed (409)
kind: term
status: draft
aliases: [price_changed]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# price_changed (409)
## Definition
`price_changed` is the `409` error [`POST /checkout`](post-checkout.md) returns when the client's [`expectedTotalMinor`](expected-total-minor.md) does not match the total the server calculated from [current catalog prices](catalog-domain-layer.md). The response carries the current total, so the client can show the new price and ask the buyer to confirm again.

## Example
A × 2 was shown for 2000, but A now costs 1200. Checkout answers `409 price_changed` with the current total of 2400.

## Known gaps
- The spec does not say the name of [the body member](extension-members.md) that carries the current total.
- The spec does not say whether the check runs before an order exists. That decides whether [the key is released](idempotency-key.md), letting the buyer retry with the same key, or whether the outcome is final.

## Used by
<!-- used-by:start -->
- [catalog-domain-layer](catalog-domain-layer.md)
- [extension-members](extension-members.md)
- [idempotency-key](idempotency-key.md)
<!-- used-by:end -->
