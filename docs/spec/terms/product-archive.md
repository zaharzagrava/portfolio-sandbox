---
id: product-archive
title: Archived product
kind: term
status: draft
aliases: [archive, archived, restore]
defined_for: S05-products
rules_hash: 029f4581cddc
---
# Archived product
## Definition
An archived product has the status `ARCHIVED`. A member with [`products.write`](permission.md) archives it and can restore it to `ACTIVE`. Archive and restore each need [`expectedVersion`](expected-version.md), add a [status-history row](product-status-history.md) and increase the version. An archived product cannot be edited and is never public: anonymous readers get the same `404` as for an unknown ID. The shop list hides it by default, because the default status filter is `ACTIVE`.

## Example
`POST /shops/:shopId/products/:productId/archive` moves the product to `ARCHIVED`. After that, a `PATCH` gets `409 product_archived`, and `GET /products/:productId` gets `404` with [`Cache-Control: public, s-maxage=5` ↗](../sw-external-terms.md#cache-control). `POST .../restore` makes it `ACTIVE` again.

## Known gaps
- The spec does not say whether [`applyStockDelta`](apply-stock-delta.md) still works on an archived product.
- The spec does not say the parameter name or values for listing archived products instead of the default `ACTIVE` ones.
- The external upsert (`upsertFromExternal`) never revives an archived product. The spec does not say what that call returns in this case.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-07, B-05
- [S10](../capabilities/S10-cart-checkout.md): B-09
- [S32](../capabilities/S32-product-search.md): R-06, B-09, B-28
- [W02](../capabilities/W02-storefront-discovery.md): R-18
- [batch-products-lookup](batch-products-lookup.md)
- [expected-version](expected-version.md)
- [get-product-by-id](get-product-by-id.md)
- [product-status-history](product-status-history.md)
- [upsert-from-external](upsert-from-external.md)
- [version-conflict](version-conflict.md)
<!-- used-by:end -->
