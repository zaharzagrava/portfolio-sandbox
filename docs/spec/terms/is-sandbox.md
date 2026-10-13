---
id: is-sandbox
title: isSandbox flag
kind: term
status: draft
aliases: [issandbox]
defined_for: S05-products
rules_hash: 1ad09d7a5e45
---
# isSandbox flag
## Definition
`isSandbox` is a flag on a product. It is set when the product is created in a [sandbox shop](sandbox-shop.md). Every product event carries the flag, so [consumers](event-consumer.md) can tell sandbox data from real data. A product with this flag is never public. [A public read of it gets the same answer as an unknown product ID.](identical-not-found.md)

## Example
A member of a sandbox shop creates a product with `POST /shops/:shopId/products`. The stored product has `isSandbox` set, and its `catalog.product_created` event carries the flag. An anonymous `GET /products/:productId` for that product returns `404` with [`Cache-Control: public, s-maxage=5` ↗](../sw-external-terms.md#cache-control).

## Known gaps
- The spec does not say whether the flag can ever change, for example if a shop stops being a sandbox shop.
- The spec does not say where the flag sits inside the [event payload](event-payload.md).
- The spec does not say whether sandbox products appear in the [members' shop list](shop-member.md) (`GET /shops/:shopId/products`) or in other domains, such as search.

## Used by
<!-- used-by:start -->
- [catalog-product-events](catalog-product-events.md)
- [event-consumer](event-consumer.md)
- [event-payload](event-payload.md)
- [identical-not-found](identical-not-found.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
