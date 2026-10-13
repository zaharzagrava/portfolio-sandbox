---
id: search-document
title: Search document
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# Search document
## Definition
A search document is one product's entry in the [search index](search-index.md). The [search projector](search-projector.md) writes it from [events](event-payload.md), and the catalog's table is never read. It holds the fields that search matches, filters, sorts and [facets](search-facets.md) on. It also holds the [stored product version](product-version.md), which is used to accept or ignore incoming events. It may hold a [product embedding vector](product-embedding-vector.md), and that vector never appears in any response.

## Example
For one product, the document holds its title, brand, description and tags for text matching, plus its category, price, rating and stock for filters and facets. It also stores its version (illustrative: 7). When only the price changes, the document is updated and its existing vector is kept.

## Known gaps
- The spec does not list the full field set of a document. The fields above come from the matching, filter, facet and sort rules, not from a stated mapping.
- The spec does not say whether a deleted product stays in the index as a [tombstone document](shop-tombstone.md) holding the delete version. The rule on [late events](dropped-late-event.md) and the [`search.purge-tombstones` job](search-purge-tombstones-job.md) suggest it does, but the spec does not describe it.
- The spec does not say how a document records that a shop is hidden. It does not say whether the shop's state is copied into each document or looked up at query time.

## Used by
<!-- used-by:start -->
- [dropped-late-event](dropped-late-event.md)
- [event-payload](event-payload.md)
- [price-only-update](price-only-update.md)
- [product-embedding-vector](product-embedding-vector.md)
- [product-version](product-version.md)
- [search-facets](search-facets.md)
- [search-index](search-index.md)
- [search-projector](search-projector.md)
- [search-purge-tombstones-job](search-purge-tombstones-job.md)
- [shop-tombstone](shop-tombstone.md)
<!-- used-by:end -->
