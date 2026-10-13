---
id: use-case
title: Use case
kind: term
status: draft
aliases: [use-case steps]
defined_for: S05-products
rules_hash: 631715b02962
---
# Use case
## Definition
A use case is one complete piece of business behaviour, such as "apply a stock change" or "flush pending view counts". In this system, one service in the application layer carries out each use case from start to finish. An [entry point](entry-point.md) (a controller, a consumer, a job or an [exported command](exported-command.md)) starts the use case. The use case then calls the [domain layer](domain-layer.md)'s rules and does the reads and writes.

## Example
"Apply a stock delta" is a use case in [`ProductStockService`](product-stock-service.md) (`packages/backend/libs/domains/catalog/application/product-stock.service.ts`). It checks the bounds with [`applyDelta`](apply-delta.md) and writes the change in one transaction. It also deduplicates by [`operationId`](stock-operation-id.md). With stock 5 and ten concurrent `-1` operations, five apply and five get [`insufficient_stock`](insufficient-stock.md).

## Known gaps
- The spec does not say whether every use case has its own service or method. Several use cases may share one service; for example, [`ProductCommandService`](product-command-service.md) probably covers create, update, archive and restore.
- Not confirmed in the code: whether each use case opens its own transaction or relies on a caller's [active transaction](active-transaction.md).

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [api-layer](api-layer.md)
- [application-layer](application-layer.md)
- [domain-layer](domain-layer.md)
- [entry-point](entry-point.md)
- [exported-command](exported-command.md)
<!-- used-by:end -->
