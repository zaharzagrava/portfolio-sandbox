---
id: shop-product-search-route
title: GET /shops/:shopId/products/search
kind: term
status: draft
aliases: [shop search route]
defined_for: S32-product-search
rules_hash: ac5fd93fb9e2
---
# GET /shops/:shopId/products/search
## Definition
`GET /shops/:shopId/products/search` lets a shop member search their own shop's products by text. The caller needs read permission on the shop, and the request must pass the [shop status gate](shop-status-gate.md). Unlike the public route, it is meant for sellers managing their own catalog. It has its own [rate limit policy](rate-limit-policy.md), [`discovery.shop-search`](rate-limit-policy.md). The capability owns a separate [shop search table](shop-search-table.md) that uses [relational full-text search ↗](../sw-external-terms.md#full-text-search), apart from the [public search index](search-index.md).

## Example
A shop member of shop `shop_123` (illustrative id) searches their catalog:
```
GET /shops/shop_123/products/search?q=airpods
→ 200 with matching products from shop_123 only
```

## Known gaps
- Not confirmed in the code: the [cross-tenant `404`](identical-not-found.md), the status gate and the shop rate limit. No test carries their scenario ids (AS-61 to AS-66, AS-68, AS-69). Only lifecycle and freshness (AS-67) is tested.
- The spec does not say which query parameters, sort orders or response schema this route shares with `GET /products/search`.
- The spec does not say whether members can see products hidden from public search, such as archived or sandbox products. It also does not explicitly say that this route reads from the shop search table.

## Used by
<!-- used-by:start -->
- [identical-not-found](identical-not-found.md)
- [rate-limit-policy](rate-limit-policy.md)
- [search-index](search-index.md)
- [shop-search-q-parameter](shop-search-q-parameter.md)
- [shop-search-table](shop-search-table.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
