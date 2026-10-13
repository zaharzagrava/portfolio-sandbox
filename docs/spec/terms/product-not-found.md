---
id: product-not-found
title: product_not_found (404)
kind: term
status: draft
aliases: [product_not_found]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# product_not_found (404)
## Definition
`product_not_found` is the `404` error for a product ID that the caller cannot see. The same answer covers a product that does not exist and a product that belongs to another shop. On the public read, a product that is not publicly visible also gets this unknown-ID answer. That includes archived products, [sandbox products](sandbox-product.md), and products of a [suspended or offboarding shop](shop-status.md). A malformed ID is different: it gets [`validation_failed`](validation-failed-error.md) before any lookup.

## Example
A member of shop A calls `GET /shops/A/products/<id of a shop-B product>` and gets `404 product_not_found`.
An anonymous `GET /products/:productId` for an archived product gets `404` with [`Cache-Control: public, s-maxage=5` ↗](../sw-external-terms.md#cache-control).

## Known gaps
- The spec does not say whether the public `404` carries the `product_not_found` code or only matches it in status and body.
- The spec does not say whether [`GET /batch/products`](batch-shops-lookup.md) uses this error. It returns `null` in that item's position instead.

## Used by
<!-- used-by:start -->
- [sandbox-product](sandbox-product.md)
- [shop-status](shop-status.md)
<!-- used-by:end -->
