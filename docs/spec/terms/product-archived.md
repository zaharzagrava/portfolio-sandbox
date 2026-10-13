---
id: product-archived
title: product_archived (409)
kind: term
status: draft
aliases: [product_archived]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# product_archived (409)
## Definition
`product_archived` is the error code of a `409` conflict. The server returns it when a client tries to edit a product whose status is `ARCHIVED`. The product must be restored first before it can be edited. It is different from `invalid_transition`, which is the error for a status move that the lifecycle does not allow.

## Example
A client sends `PATCH /shops/:shopId/products/:productId` on an archived product. The answer is `409` with `"code": "product_archived"`. The client should call `.../restore` first and then retry the edit.

## Known gaps
- The spec does not say which error is returned first when the edit also carries a stale `expectedVersion`.
- The spec does not say whether `upsertFromExternal` gives this error or silently skips an archived product. The facts only say that the upsert never revives an archived product.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
