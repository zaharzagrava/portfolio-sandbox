---
id: product-lifecycle
title: Product lifecycle
kind: term
status: draft
aliases: [lifecycle]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# Product lifecycle
## Definition
The product lifecycle has only two statuses: `ACTIVE` and `ARCHIVED`. A product starts `ACTIVE`. A member with [`products.write`](permission.md) moves it with `archive` and `restore`. Each move adds a [`ProductStatusHistory`](product-status-history.md) row, increments [`version`](product-version.md) and [writes an event](outbox-append.md). Any other move gives [`invalid_transition`](invalid-transition.md). The external upsert ([`upsertFromExternal`](upsert-from-external.md)) never brings an archived product back to `ACTIVE`.

## Example
```
POST /shops/:shopId/products/:productId/archive   { "expectedVersion": 2 }  → ARCHIVED, version 3
POST /shops/:shopId/products/:productId/restore   { "expectedVersion": 3 }  → ACTIVE,   version 4
```
Archiving a product that is already `ARCHIVED` gives `409 invalid_transition`. (Version numbers and the body shape are illustrative.)

## Known gaps
- The spec does not say how a product is deleted, or which flow emits [`catalog.product_deleted`](catalog-product-deleted-event.md). That event is listed, but deletion is not part of the lifecycle.
- The spec does not say whether [`applyStockDelta`](apply-stock-delta.md) is refused on an `ARCHIVED` product.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [catalog-domain-layer](catalog-domain-layer.md)
- [outbox-append](outbox-append.md)
- [product-command-service](product-command-service.md)
<!-- used-by:end -->
