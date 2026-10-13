---
id: shop-query-service
title: ShopQueryService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ShopQueryService
## Definition
`ShopQueryService` is one of the services that the [tenancy capability (S03)](capability.md) exports for other capabilities to use. Its name suggests it gives read-only access to shop data, such as a shop's name, slug, plan, status or verification. Other capabilities read shops through it instead of querying tenancy tables directly. This is design intent (not stated in the spec). It is exported alongside [`ShopAccessService`](shop-access-service.md), [`MembershipQueryService`](membership-query-service.md), [`ShopProvisioningService`](shop-provisioning-service.md) and [`ShopCellService`](shop-cell-service.md).

## Example
Possible use (the facts do not link this read to this service): `GET /batch/shops?ids=…` returns `{id, name, slug}` for each shop, in request order. It returns `null` for sandbox, suspended, deleting or deleted shops.
```json
[{ "id": "shop_1", "name": "Acme", "slug": "acme" }, null]
```
(ids and names are illustrative)

## Known gaps
- Not confirmed in the code: which methods `ShopQueryService` exposes, and which tables it reads (`Shop`, `ShopDirectory` or others).
- The spec does not say whether it hides sandbox, suspended or deleted shops the way `GET /batch/shops` does, or returns them with their status.
- The spec does not say whether it needs a tenant set or a [cross-tenant bypass reason](cross-tenant-bypass.md) to read across shops.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [cross-tenant-bypass](cross-tenant-bypass.md)
<!-- used-by:end -->
