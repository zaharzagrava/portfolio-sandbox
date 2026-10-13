---
id: shop-id-param
title: shopId
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# shopId
## Definition
`shopId` is the ID of the shop that sells a product. The [BFF ↗](../sw-external-terms.md#bff) reads it from the [product upstream](upstream.md)'s answer. The [`shop` section](section.md) is a [dependent section](dependent-section.md): it starts only after the product has answered, and it uses the product's `shopId`. If the product has no `shopId`, the shop section does not apply. It is then `null`, with no [errors entry](errors-entry.md) and no upstream call. Do not confuse it with the [`X-Shop-Id` header](x-shop-id-header.md), which the BFF never forwards.

## Example
The product body has no `shopId`, so the page returns `"shop": null`. The `errors` list has no `shop` entry, and no shop upstream is called.

## Known gaps
- The spec does not say whether sections other than `shop` (for example `pickup`) also need `shopId`.

## Used by
<!-- used-by:start -->
- [dependent-section](dependent-section.md)
- [errors-entry](errors-entry.md)
- [section](section.md)
- [upstream](upstream.md)
- [x-shop-id-header](x-shop-id-header.md)
<!-- used-by:end -->
