---
id: legacy-seller
title: Legacy seller
kind: term
status: draft
aliases: [legacy sellers]
defined_for: S03-shops-rbac
rules_hash: 27abe9e9ee92
---
# Legacy seller
## Definition
A legacy seller is a seller who existed before shops became the [tenant](tenant.md) of the marketplace. Such a seller may have no shop yet. [`ensureShopsForLegacySellers`](ensure-shops-for-legacy-sellers.md) gives each legacy seller exactly one shop, so they fit the [shop-based tenancy](shop-tenant.md) and [roles](shop-role.md) model.

## Example
A seller signed up under the older model and owns no `Shop` row. When `ensureShopsForLegacySellers` runs, it creates a shop for that seller. Running it again changes nothing.

## Known gaps
- The spec does not say how the system tells a legacy seller apart from other users, for example by a flag, a table or the absence of a [membership](shop-membership.md).
- The spec does not say whether a legacy seller's shop counts toward the [owned-shop limit](max-owned-shops.md) of S03.R-12.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-16
- [S05](../capabilities/S05-products.md): B-22
- [catalog-product-events](catalog-product-events.md)
- [ensure-shops-for-legacy-sellers](ensure-shops-for-legacy-sellers.md)
- [max-owned-shops](max-owned-shops.md)
- [shop-membership](shop-membership.md)
- [shop-provisioning-service](shop-provisioning-service.md)
- [shop-role](shop-role.md)
- [shop-tenant](shop-tenant.md)
- [tenant](tenant.md)
<!-- used-by:end -->
