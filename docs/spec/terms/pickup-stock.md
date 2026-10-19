---
id: pickup-stock
title: Pickup stock
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: dca3aaf33c77
---
# Pickup stock
## Definition
Pickup stock is the quantity a seller sets for a product at a specific [pickup point](pickup-point.md). It is separate from [catalog stock](catalog-stock.md) and the two never overwrite each other. A catalog stock change does not alter pickup stock, and pickup stock does not hide a catalog stock change. Setting pickup stock is what makes a product show up in the near-me index.

## Example
[CSV product](csv-product.md) `Pc` has catalog stock 5 and pickup stock 4 at pickup point `PP1`. A stock change on the catalog side leaves the pickup count at 4, and no [Shopify write](shopify-write.md) occurs because `Pc` is not linked (J04 B-12).

## Known gaps
- The spec does not say whether a [device sale](device-sale.md) lowers pickup stock.
- The spec does not say whether pickup stock may exceed catalog stock.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
