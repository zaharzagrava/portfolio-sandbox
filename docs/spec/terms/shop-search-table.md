---
id: shop-search-table
title: Shop search table
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: beae75ecd227
---
# Shop search table
## Definition
The shop search table is a relational table that [S32](../capabilities/S32-product-search.md) owns and searches with the database's own [full-text matching ↗](../sw-external-terms.md#full-text-search). It is separate from the [search index](search-index.md) that the [search engine](search-engine.md) serves to public search. Design intent (not stated in the spec): it supports searching within a single shop's products, so a [shop member](shop-member.md) can search their own products without going through the public engine. The spec lists a shop-table rebuild among the [reindex run](zero-downtime-reindexing.md) behaviors, and a test covers its lifecycle and freshness.

## Example
Design intent (not stated in the spec): a member of shop `shop_123` (illustrative id) sends this request, and the matches come from the shop search table, not from the [live index name](live-index-alias.md).
```
GET /shops/shop_123/products/search?q=airpods
```

## Known gaps
- The spec does not say that `GET /shops/:shopId/products/search` reads from this table. It also does not say which events fill the table or what columns it has.
- The spec does not say whether the table keeps products that public search hides, such as archived, [sandbox](sandbox-product.md) or deleted products.
- Not confirmed in the code: the shop-table rebuild during a reindex run has only its [proof id](rule-proof.md), and no rule states it. Of the shop search scenarios, only [AS-67](acceptance-scenario.md) (lifecycle and freshness) has a test.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [live-index-alias](live-index-alias.md)
- [rule-proof](rule-proof.md)
- [sandbox-product](sandbox-product.md)
- [search-engine](search-engine.md)
- [search-index](search-index.md)
- [shop-member](shop-member.md)
- [shop-product-search-route](shop-product-search-route.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
