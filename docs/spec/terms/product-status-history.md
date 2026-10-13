---
id: product-status-history
title: ProductStatusHistory
kind: term
status: draft
aliases: [status history]
defined_for: S05-products
rules_hash: 9d06c95a9f02
---
# ProductStatusHistory
## Definition
`ProductStatusHistory` is a table owned by [S05 (product service)](../capabilities/S05-products.md). It records each move of a product between `ACTIVE` and [`ARCHIVED`](product-archive.md). Every archive or restore adds one row, in the same write that increments the product's [`version`](product-version.md). The `Product` row holds only the current status. This table keeps the history of how the product got there.

## Example
A member with [`products.write`](permission.md) calls `POST /shops/:shopId/products/:productId/archive` with the current [`expectedVersion`](expected-version.md). The product becomes `ARCHIVED`, its `version` goes up by one, and one `ProductStatusHistory` row is added. A later `.../restore` adds a second row for the move back to `ACTIVE`.

## Known gaps
- The spec does not say which columns a `ProductStatusHistory` row has, such as the previous status, the actor, the time or the version.
- The spec does not say whether creating a product (which starts `ACTIVE`) also writes a history row.
- The spec does not say how long rows are kept. The only purge job it lists is for stock operations.

## Used by
<!-- used-by:start -->
- [product-archive](product-archive.md)
- [shop-deleted-event](shop-deleted-event.md)
<!-- used-by:end -->
