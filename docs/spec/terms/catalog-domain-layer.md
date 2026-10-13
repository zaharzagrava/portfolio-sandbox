---
id: catalog-domain-layer
title: Catalog domain layer
kind: term
status: draft
aliases: [catalog domain]
defined_for: S05-products
rules_hash: 0155cc1e9a05
---
# Catalog domain layer
## Definition
The catalog domain layer is the `domain` folder of the catalog code. It holds the product rules themselves, apart from HTTP and storage. Controllers sit in the `api` folder, services such as [`ProductStockService`](product-stock-service.md) in `application`, and cache and job code in `infra`. The domain layer holds input parsing, [lifecycle transitions](product-lifecycle.md), [public visibility](search-visibility.md) and [stock arithmetic](stock-delta.md). Keeping these rules in one place, away from HTTP and storage, is design intent (not stated in the spec).

## Example
These are the domain-layer functions the spec cites. Each one carries one rule:
```
packages/backend/libs/domains/catalog/domain/product-input.ts   parseCreateInput    (S05.R-02 strict body)
packages/backend/libs/domains/catalog/domain/product-status.ts  applyTransition     (S05.R-09 ACTIVE ⇄ ARCHIVED)
packages/backend/libs/domains/catalog/domain/visibility.ts      isPubliclyVisible   (S05.R-12 public or 404)
packages/backend/libs/domains/catalog/domain/stock-rule.ts      applyDelta          (S05.R-19 stock bounds)
```

## Known gaps
- Not confirmed in the code: whether domain-layer functions are pure, meaning they never touch the database, the cache or the clock.
- The spec does not say which layers may import from which. For example, it does not say whether `api` controllers may call `domain` functions directly or must go through [`ProductCommandService`](product-command-service.md).
- Not confirmed in the code: whether the `PATCH` update path and `upsertFromExternal` use the same domain functions as create, such as `parseCreateInput`.

## Used by
<!-- used-by:start -->
- [apply-delta](apply-delta.md)
- [expected-total-minor](expected-total-minor.md)
- [parse-create-input](parse-create-input.md)
- [price-changed](price-changed.md)
- [product-lifecycle](product-lifecycle.md)
- [product-stock-service](product-stock-service.md)
- [search-visibility](search-visibility.md)
- [stock-delta](stock-delta.md)
<!-- used-by:end -->
