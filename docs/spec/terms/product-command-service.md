---
id: product-command-service
title: ProductCommandService
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# ProductCommandService
## Definition
`ProductCommandService` is the exported write service of [S05](../capabilities/S05-products.md) for products. The product controllers and other domains call this same service, so one code path enforces every product rule. Writes through it must follow the [strict body rules](strict-body.md), the [shop status gate](shop-status-gate.md), [`expectedVersion`](expected-version.md) checks and the [`ACTIVE ⇄ ARCHIVED` lifecycle](product-lifecycle.md). Each committed change writes one versioned product event in the same transaction, and the product's [cache entry](cache-entry.md) is deleted after commit.

## Example
A `STAFF` member sends `PATCH /shops/:shopId/products/:productId` with the current `expectedVersion` and a new price. The controller hands the change to `ProductCommandService`. The answer is `200` with `version` plus one, and a `catalog.product_updated` event is written. If the version is stale, the answer is `409 version_conflict` with `currentVersion`, and nothing changes.

## Known gaps
- The spec does not say which methods `ProductCommandService` exposes or what their signatures are. The facts also give no source path for it.
- The spec does not say whether the `catalog.product-write.shop` rate limit and the shop status checks run inside this service or in the controllers. If they run in the controllers, other domains that call the service directly might skip them.
- Not confirmed in the code: that `ProductImportService.upsertFromExternal` and `ProductStockService.applyStockDelta` write through `ProductCommandService`. They are listed as separate exported commands.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [product-lifecycle](product-lifecycle.md)
- [shop-status-gate](shop-status-gate.md)
- [strict-body](strict-body.md)
<!-- used-by:end -->
