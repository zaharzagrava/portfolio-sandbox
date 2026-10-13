---
id: shop-access-service
title: ShopAccessService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ShopAccessService
## Definition
`ShopAccessService` is one of the services that the [tenancy capability (S03)](tenancy-domain-layer.md) exports for other capabilities to use. Its name suggests it answers whether a caller may act inside a shop. That answer covers [shop membership](shop-membership.md), [shop role](shop-role.md), permission and the [shop status gate](shop-status-gate.md). Other capabilities call an exported service instead of reading tenancy tables directly. This is design intent (not stated in the spec). It is exported alongside [`ShopQueryService`](shop-query-service.md), [`MembershipQueryService`](membership-query-service.md), [`ShopProvisioningService`](shop-provisioning-service.md) and [`ShopCellService`](shop-cell-service.md).

## Example
Possible use (the facts do not link this check to this service): another capability checks a caller against shop `shop_123` (illustrative id). A non-member gets the same `404 shop_not_found` as for an unknown shop. A member without the permission gets `403 permission_denied`. A `SUSPENDED` shop refuses anything beyond `shop.read`, `members.read` and `shop.export` with `403 shop_suspended`.

## Known gaps
- Not confirmed in the code: which methods `ShopAccessService` exposes, and whether it is the code behind [`ShopGuard`](shop-guard.md) or the topic check on `shop:<shopId>:live`.
- The spec does not say whether this service reads through the [authorization cache](authorization-cache.md) or checks the database directly. The spec does say that sensitive permissions always read the database.
- The spec does not say whether callers of this service get the same answer order as HTTP callers (`401`, `404`, `403 permission_denied`, then the status gate).

## Used by
<!-- used-by:start -->
- [authorization-cache](authorization-cache.md)
- [shop-membership](shop-membership.md)
- [shop-role](shop-role.md)
- [shop-status-gate](shop-status-gate.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
