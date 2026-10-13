---
id: application-layer
title: Application layer
kind: term
status: draft
aliases: [application]
defined_for: S05-products
rules_hash: 70c8be72d7fb
---
# Application layer
## Definition
The application layer is the `application` folder of a [domain](domain.md). It holds the services that carry out one [use case](use-case.md) from start to finish. These services are called by the [`api` controllers](api-layer.md), by [`infra` consumers](infrastructure-layer.md) and jobs, or by other domains through [exported commands](exported-command.md). They rely on the [pure rules](domain-layer.md) in the `domain` folder and do the actual reads and writes. Keeping use-case steps apart from HTTP, messaging and pure rules makes each part easier to test and change. This is design intent (not stated in the spec).

## Example
Files in `packages/backend/libs/domains/catalog/application/`:
- `product-stock.service.ts` (`ProductStockService`, exports [`applyStockDelta`](apply-stock-delta.md) to other domains)
- `product-views.service.ts` (`ProductViewsService`, flushes [pending view counts](view-count-claim.md) in chunks)
- `shop-listing.service.ts` (`ShopListingService`, deletes a shop's products after [`tenancy.shop_deleted`](shop-deleted-event.md))
- `product-backfill.service.ts` (`ProductBackfillService`, assigns shops to products that have none)

## Known gaps
- Not confirmed in the code: whether the other exported services (`ProductCommandService`, `ProductQueryService`, `ProductImportService`) are also in the `application` folder. The facts only give a file path for `ProductStockService`.
- The spec does not say what each layer may import. For example, it does not say whether `application` code may use `infra` code directly.
- Not confirmed in the code: whether every domain uses the same `api` / `application` / `domain` / `infra` split. The facts only show this split for catalog.

## Used by
<!-- used-by:start -->
- [api-layer](api-layer.md)
- [domain-layer](domain-layer.md)
- [domain](domain.md)
- [exported-command](exported-command.md)
- [infrastructure-layer](infrastructure-layer.md)
- [reconciliation-run-service](reconciliation-run-service.md)
- [use-case](use-case.md)
- [view-count-claim](view-count-claim.md)
<!-- used-by:end -->
