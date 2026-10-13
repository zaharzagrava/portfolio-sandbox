---
id: ensure-shops-for-legacy-sellers
title: ensureShopsForLegacySellers
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ensureShopsForLegacySellers
## Definition
`ensureShopsForLegacySellers` is a provisioning operation that gives each [legacy seller](legacy-seller.md) a [shop](shop-tenant.md). It is [idempotent ↗](../sw-external-terms.md#idempotency): running it again never creates a second shop for the same seller. This makes it safe to re-run after a partial failure or a redeploy. That safety is design intent (not stated in the spec).

## Example
Legacy sellers A and B have no shop yet. The first call creates one shop for A and one for B. A second call finds both shops and creates nothing. Each seller still has exactly one shop.

## Known gaps
- Not confirmed in the code: which service holds this operation. [`ShopProvisioningService`](shop-provisioning-service.md) is a likely home, but the facts do not link the two.
- The spec does not say what plan, status, verification state or slug the created shops get. It also does not say whether the seller becomes the shop's [`OWNER`](shop-role.md).
- The spec does not say how it is triggered (migration, job or startup) or whether creating these shops emits `tenancy.shop_created`.

## Used by
<!-- used-by:start -->
- [legacy-seller](legacy-seller.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
