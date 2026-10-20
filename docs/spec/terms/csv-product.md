---
id: csv-product
title: CSV product
kind: term
status: draft
aliases: [csv products]
defined_for: J04-catalog-sync-to-search
rules_hash: 01cdffb02101
---
# CSV product
## Definition
A CSV product is a product that entered the catalog through a [bulk import file](catalog-import-file.md) rather than from a [Shopify store](shopify-connection.md). It is not linked to Shopify, so its stock changes never cause a [Shopify write](shopify-write.md). Like every product, it changes only through the catalog's [exported commands](exported-command.md). It shows in search, and it shows in [near-me](pickup-near-me.md) once it has [pickup stock](pickup-stock.md).

## Example
CSV product `Pc` has [catalog stock](catalog-stock.md) 5 and pickup stock 4 at [`PP1`](pickup-point.md). When its catalog stock changes, Shopify is not called. The `PP1` pickup count stays at 4.

## Known gaps
- The spec does not say whether a CSV product can later be linked to a [Shopify variant](shopify-variant.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
