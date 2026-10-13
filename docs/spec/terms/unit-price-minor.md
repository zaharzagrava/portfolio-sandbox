---
id: unit-price-minor
title: Unit price (unitPriceMinor)
kind: term
status: draft
aliases: [unit price, unitpriceminor]
defined_for: S10-cart-checkout
rules_hash: 92918a91791d
---
# Unit price (unitPriceMinor)
## Definition
The unit price is what one unit of a product costs on an [order line](cart-line.md), stored as an integer in [minor units](minor-units.md). At checkout the server reads it from the catalog and never takes it from the client. It is multiplied by the quantity to get the line total before any discount. If prices changed and the server total no longer matches the client's [`expectedTotalMinor`](expected-total-minor.md), checkout answers [`price_changed`](price-changed.md).

## Example
The catalog price of a product is `1500` (for example, 15.00 in the platform currency), and the buyer orders `2` units. Before discount, the line comes to `3000`. The values are illustrative.

## Known gaps
- Not confirmed in the code: that the order item field is named `unitPriceMinor`. The only place that name appears marks it as illustrative.
- The spec does not say whether the unit price is copied onto the order item at checkout, or looked up again later (for example, by the backfill).

## Used by
<!-- used-by:start -->
- [cart-line](cart-line.md)
- [line-total-minor](line-total-minor.md)
- [minor-units](minor-units.md)
- [order-items-backfill](order-items-backfill.md)
- [orders-backfill-item-titles-job](orders-backfill-item-titles-job.md)
<!-- used-by:end -->
