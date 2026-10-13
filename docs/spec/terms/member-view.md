---
id: member-view
title: Member view (product)
kind: term
status: draft
aliases: [public view]
defined_for: S05-products
rules_hash: 65df17c71e0c
---
# Member view (product)
## Definition
The member view is the version of a product that [shop members](shop-member.md) see through the `/shops/:shopId/products` endpoints. Create, get-by-ID and update all return it, and it includes the product's [`version`](product-version.md). It is separate from the public view, which `GET /products/:productId` returns without credentials. Only a member with the [right permission](permission.md) gets it. A non-member gets the same `404` as for an unknown shop.

## Example
A [`STAFF`](shop-role.md) member posts a valid product to `POST /shops/:shopId/products` and gets back `201` with the member view at `version: 1`.

## Known gaps
- The spec does not say which fields the member view has that the public view lacks, or the other way round.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): B-01, B-06
- [permission](permission.md)
- [product-view-count](product-view-count.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
