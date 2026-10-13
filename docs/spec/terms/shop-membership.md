---
id: shop-membership
title: Shop membership (non-member)
kind: term
status: draft
aliases: [member]
defined_for: S05-products
rules_hash: 213a7dd75ff9
---
# Shop membership (non-member)
## Definition
Shop membership means a user belongs to a shop with a [shop role](shop-role.md). The role decides which [permissions](permission.md) the user has on that shop's products. A signed-in user who is not a member of the shop gets the same [`404`](identical-not-found.md) as for a shop that does not exist. That user does not get a `403`. A member whose role lacks the needed permission, such as a [`VIEWER`](viewer.md) trying to write, gets [`403 permission_denied`](permission-denied.md) instead.

Design intent (not stated in the spec): the identical `404` keeps outsiders from finding out which shop IDs exist.

## Example
A signed-in user who is not a member calls `GET /shops/:shopId/products` for a real shop. The answer is the same `404` that an unknown `shopId` would get.

## Known gaps
- The spec does not say which error code this `404` carries. For example, it does not confirm that it is `shop_not_found`.
- The spec does not say where membership is checked, for example whether it is checked before the [shop status gate](shop-status-gate.md).

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-04
- [identical-not-found](identical-not-found.md)
- [legacy-seller](legacy-seller.md)
- [membership-query-service](membership-query-service.md)
- [permission](permission.md)
- [shop-access-service](shop-access-service.md)
- [shop-limit-reached](shop-limit-reached.md)
- [shop-member](shop-member.md)
- [shop-role](shop-role.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
