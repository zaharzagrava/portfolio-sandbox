---
id: is-publicly-visible
title: isPubliclyVisible
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: c6b950514ab0
---
# isPubliclyVisible
## Definition
`isPubliclyVisible` is the [catalog domain](catalog-domain-layer.md) check that decides whether anyone may see a product without credentials. A product passes only if it is [`ACTIVE`](product-lifecycle.md) and its shop is a [live, non-sandbox shop](live-shop.md). The shop must also not be [`SUSPENDED`](shop-status.md), `DELETING` or `DELETED`. When the check fails, the public read gives the [identical 404](identical-not-found.md) that an unknown product ID gets, so callers cannot learn that the product exists. Archived products, sandbox products and products of suspended or offboarding shops all fail it.

## Example
Shop suspended at [`shopVersion: 5`](shop-version.md): `GET /products/:productId` for any of its 2,500 products answers `404`. After reinstatement at `shopVersion: 6`, the same call answers `200` again.
`GET /batch/products?ids=a,b,c` where `b` fails the check returns `[a, null, c]` in request order.
An archived product read anonymously returns `404` with `Cache-Control: public, s-maxage=5`.

## Known gaps
- The spec does not say whether the check runs again when a cache entry is served, or only when the entry is loaded from the database. This decides how fast a suspension or archive hides a cached product.
- Not confirmed in the code: where `isPubliclyVisible` gets the shop status. The catalog keeps it from `tenancy.shop_status_changed`, but the spec does not say whether `ProductShopState` is the store it reads.
- The spec does not say which error code the public 404 carries. It only says the 404 equals the unknown-ID answer.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-10
- [catalog-domain-layer](catalog-domain-layer.md)
- [domain-layer](domain-layer.md)
- [identical-not-found](identical-not-found.md)
- [live-shop](live-shop.md)
- [near-me-index](near-me-index.md)
<!-- used-by:end -->
