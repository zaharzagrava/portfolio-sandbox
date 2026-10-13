---
id: price-only-update
title: Price-only update
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: 356acaeb67d0
---
# Price-only update
## Definition
A price-only update is a product change where the price changes and title, description, brand, category and tags stay the same. When the [search projector](search-projector.md) applies it, the [embedding provider](embedding-provider.md) is not called. A [vector](product-embedding-vector.md) is computed only when one of those text fields changes. Skipping the call avoids provider cost and latency for changes that cannot affect [semantic meaning](semantic-search.md). That reason is design intent (not stated in the spec).

## Example
A seller lowers a product's price and nothing else changes. The resulting [`catalog.product_updated` event](catalog-product-updated-event.md) updates the [search document](search-document.md), and the product's existing vector is kept as it is. No embedding request is made.

## Known gaps
- The spec does not say how the projector detects that only the price changed. It could compare against the stored document, or the event could list the changed fields.
- The spec does not say whether other non-text changes, such as stock or images, follow the same rule. The rule implies they do, but no scenario covers them.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-25
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [embedding-provider](embedding-provider.md)
- [product-embedding-vector](product-embedding-vector.md)
- [search-document](search-document.md)
- [search-projector](search-projector.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
