---
id: batch-shops-lookup
title: Batch shops lookup (GET /batch/shops)
kind: term
status: draft
aliases: [/batch/shops]
defined_for: S03-shops-rbac
rules_hash: 6d6feb80ae5c
---
# Batch shops lookup (GET /batch/shops)
## Definition
`GET /batch/shops` is an [anonymous endpoint](viewer.md) that reads many shops in one call. The [BFF ↗](../sw-external-terms.md#bff) uses it to show shop names and [slugs](shop-slug.md). It returns an array in the same order as the requested ids. Each entry is `{id, name, slug}`, or `null` for a shop the public should not see: [sandbox, suspended, deleting or deleted shops](shop-status.md). It is served by `ShopBatchReadController`.

## Example
```
GET /batch/shops?ids=shop_a,shop_b,shop_c      (ids illustrative)
→ [ {"id":"shop_a","name":"Acme","slug":"acme"}, null, {"id":"shop_c","name":"Bolt","slug":"bolt"} ]
```
Here `shop_b` is suspended, so its slot holds `null`.

## Known gaps
- The spec does not say the maximum number of ids per request, or what happens when you go over it.
- The spec does not say what an unknown or malformed id returns. It probably returns `null`, but this is not confirmed.
- The spec does not say which [rate-limit policy](rate-limit-policy.md), if any, applies to this anonymous endpoint.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-17, B-06
- [product-view-count](product-view-count.md)
- [rate-limit-policy](rate-limit-policy.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-slug](shop-slug.md)
- [shop-status](shop-status.md)
- [viewer](viewer.md)
<!-- used-by:end -->
