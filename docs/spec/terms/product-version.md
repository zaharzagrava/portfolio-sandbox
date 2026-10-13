---
id: product-version
title: Product version
kind: term
status: draft
aliases: [currentversion, version]
defined_for: S05-products
rules_hash: c693d5eb2c3a
---
# Product version
## Definition
The product version is a number stored on each product. It starts at `version: 1` and goes up by one with every committed change, such as an update, archive or restore. Update, archive and restore must send it as [`expectedVersion`](expected-version.md). If it does not match, the request is rejected, so of two simultaneous writes only one wins. [Cache entries](cache-entry.md) and [product events](event-definition.md) also carry the version, so a late event or a slow reader cannot bring back old data.

## Example
A client sends `PATCH /shops/:shopId/products/:productId` with `expectedVersion: 3`, but the product is already at version 4 (illustrative values):
```json
{ "code": "version_conflict", "currentVersion": 4 }
```
The status is `409` and nothing changes.

## Known gaps
- The spec does not say whether [`applyStockDelta`](apply-stock-delta.md) raises the version. It does say every committed change writes a versioned event.
- An update with no real change keeps the same version, and so does a view-count flush. Clients should not treat "same version" as "nothing was attempted".

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-13, R-14
- [cache-entry](cache-entry.md)
- [catalog-product-deleted-event](catalog-product-deleted-event.md)
- [event-definition](event-definition.md)
- [product-view-count](product-view-count.md)
- [version-conflict](version-conflict.md)
<!-- used-by:end -->
