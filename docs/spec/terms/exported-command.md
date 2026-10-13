---
id: exported-command
title: Exported command
kind: term
status: draft
aliases: [exported commands]
defined_for: S05-products
rules_hash: 381e14a4d893
---
# Exported command
## Definition
An exported command is a service method that a domain makes available for other domains to call in-process. Other domains may read prices and change stock only through the catalog's exported commands. They never touch catalog tables directly. The usual reason is that each domain stays the only writer of its own tables and keeps its rules in one place. That reason is design intent (not stated in the spec).

## Example
The catalog exports:
- `[ProductCommandService](product-command-service.md)`
- `ProductQueryService.getProductsByIds`
- `[ProductStockService](product-stock-service.md).[applyStockDelta](apply-stock-delta.md)`
- `ProductImportService.[upsertFromExternal](upsert-from-external.md)`

For example, another domain calls `applyStockDelta` with an `[operationId](stock-operation-id.md)`. If it sends the same `operationId` again, it gets `[replayed: true](stock-operation-replayed.md)` and the original `[quantityAfter](quantity-after.md)`.

## Known gaps
- The spec does not say how another domain obtains these services. For example, it does not say whether they are exported from a NestJS module.
- The spec uses "command" loosely: `getProductsByIds` is a read, but it is still listed as an exported command.
- The spec does not say which methods of `ProductCommandService` other domains may call.

## Used by
<!-- used-by:start -->
- [application-layer](application-layer.md)
- [domain-boundary-rules](domain-boundary-rules.md)
- [use-case](use-case.md)
<!-- used-by:end -->
