---
id: plan-limit
title: Plan limit
kind: term
status: draft
aliases: [enterprise, plan, pro, starter]
defined_for: tenant-shop-rbac
rules_hash: cdd5a614c088
---
# Plan limit
## Definition
The plan limit is the most places a [shop](shop-tenant.md) may have filled at once. The shop's plan sets it: `STARTER`, `PRO` or `ENTERPRISE`. The places in use are the shop's members plus any invitations that have been sent and have not yet expired. That total must never be higher than the limit. The rule values hold the actual numbers per plan.

## Example
Per tenant-shop-rbac.C-08: `STARTER` allows 5 seats, `PRO` allows 25 and `ENTERPRISE` allows 250. A `PRO` shop with 25 seats used cannot add another member or invite.

## Known gaps
- The spec does not say which error code is returned when the plan limit would be exceeded.
- The spec does not say how a shop changes plan, or what happens when a downgrade leaves the shop over its new limit.
- The spec does not say whether the limit holds under [concurrent invites ↗](../sw-external-terms.md#race-condition). The [last-owner rule](last-owner.md) explicitly covers concurrent changes, but this rule does not.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-08, B-09, B-10, B-11
- [S03](../capabilities/S03-shops-rbac.md): R-17, B-01, B-18
- [S32](../capabilities/S32-product-search.md): B-04
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-08
- [business-score](business-score.md)
- [combined-business-multiplier](combined-business-multiplier.md)
- [last-owner](last-owner.md)
- [live-shop](live-shop.md)
- [max-products](max-products.md)
- [member-provisioning](member-provisioning.md)
- [pending-invite](pending-invite.md)
- [post-shops](post-shops.md)
- [search-ranking-signals](search-ranking-signals.md)
- [seat](seat.md)
- [shop-tenant](shop-tenant.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
