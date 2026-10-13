---
id: shop-provisioning-service
title: ShopProvisioningService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ShopProvisioningService
## Definition
`ShopProvisioningService` is one of the services that the [tenancy capability (S03)](capability.md) exports for other capabilities to use. Its name says it provisions shops, which means creating or setting them up for callers outside tenancy. Other capabilities go through exported services like this one because tenancy owns its tables, which is design intent (not stated in the spec). It is exported alongside [`ShopAccessService`](shop-access-service.md), [`ShopQueryService`](shop-query-service.md), [`MembershipQueryService`](membership-query-service.md) and [`ShopCellService`](shop-cell-service.md).

## Example
Possible use (the facts do not link these operations to this service): a rollout step runs `ensureShopsForLegacySellers` twice. After both runs, each [legacy seller](legacy-seller.md) has exactly one shop. A similar step runs `ensureSandboxShop` twice for a live shop, and exactly one [sandbox shop](sandbox-shop.md) exists afterwards.

## Known gaps
- Not confirmed in the code: which methods `ShopProvisioningService` exposes. `ensureShopsForLegacySellers` and `ensureSandboxShop` are likely candidates, but nothing in the facts ties them to this service.
- The spec does not say which capabilities call this service, or whether they need a [cross-tenant bypass reason](cross-tenant-bypass.md) to do it.
- The spec does not say whether shops created through this service follow the same rules as [`POST /shops`](post-shops.md). Those rules are the `MAX_OWNED_SHOPS` limit, the slug policy, the starting plan and status, and emitting `tenancy.shop_created`.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [cross-tenant-bypass](cross-tenant-bypass.md)
- [legacy-seller](legacy-seller.md)
- [sandbox-shop](sandbox-shop.md)
<!-- used-by:end -->
