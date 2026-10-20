---
id: no-op-update
title: No-op update
kind: term
status: draft
aliases: [update that equals the stored values]
defined_for: S05-products
rules_hash: b34f3d3ccad4
---
# No-op update
## Definition
A no-op update is a `PATCH` whose values all equal the values already stored. [S05](../capabilities/S05-products.md) detects this case and does no work. It writes no product row and no [product event](event-row.md). It also leaves the product's [cache entry](cache-entry.md) in place. Design intent (not stated in the spec): this avoids useless events and [cache misses](cache-miss.md) when clients re-send forms that have not changed.

## Example
A product has the name "Blue mug" at `[version](product-version.md): 2`. A client sends `PATCH` with `[expectedVersion](expected-version.md): 2` and `name: "Blue mug"`. No `[catalog.product_updated](catalog-product-updated-event.md)` event is written, and the cached entry stays as it was. (The name and version are illustrative.)

## Known gaps
- The spec does not say what the response is (status code and `version`). The rule says no row is written, which implies `version` stays the same, but the spec does not state this.
- The spec does not say whether a stale `expectedVersion` on a no-op body still gives `[version_conflict](version-conflict.md)`.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-03
- [S05](../capabilities/S05-products.md): R-08
- [cache-entry](cache-entry.md)
- [cache-miss](cache-miss.md)
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [event-row](event-row.md)
- [products-events-topic](products-events-topic.md)
<!-- used-by:end -->
