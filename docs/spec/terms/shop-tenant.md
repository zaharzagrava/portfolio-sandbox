---
id: shop-tenant
title: Shop
kind: term
status: draft
aliases: [shops]
defined_for: tenant-shop-rbac
rules_hash: d1b0ad0cc9b4
---
# Shop
## Definition
A shop is the [tenant](tenant.md) of the marketplace: a seller organisation with a team, a plan and a status. Members act inside a shop through their [shop role](shop-role.md), which sets what they are allowed to do there. Each shop's data is kept apart, so one shop never sees or disturbs another. To a non-member, a shop gives the same answer as a shop that does not exist.

## Example
A user who is not a member of shop A asks for shop A:
```
→ [404 shop_not_found](shop-not-found.md)   (same answer as for an unknown, malformed or deleted shop)
```
A [`STARTER`](plan-limit.md) shop with 4 members and 1 unexpired [pending invite](pending-invite.md) has used all 5 [seats](seat.md) (illustrative member and invite counts).

## Known gaps
- The spec does not say what format a shop identifier has, or how it relates to the shop's slug.
- The spec does not say what S32, S50 and S51 need from a shop. They list this concept, but no line links to it.
- The spec does not say which permissions each role holds, because the FR-020 [matrix](role-permission-matrix.md) was not given.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-12
- [S05](../capabilities/S05-products.md): R-01
- [S49](../capabilities/S49-job-scheduler.md): B-13
- [W02](../capabilities/W02-storefront-discovery.md): B-14
- [ensure-shops-for-legacy-sellers](ensure-shops-for-legacy-sellers.md)
- [invite-acceptance](invite-acceptance.md)
- [invite-token](invite-token.md)
- [job-cancel-outcome](job-cancel-outcome.md)
- [job-cancel](job-cancel.md)
- [last-owner](last-owner.md)
- [legacy-seller](legacy-seller.md)
- [pagination-cursor](pagination-cursor.md)
- [pending-invite](pending-invite.md)
- [permission](permission.md)
- [plan-limit](plan-limit.md)
- [reserved-slug](reserved-slug.md)
- [role-permission-matrix](role-permission-matrix.md)
- [seat](seat.md)
- [shop-role](shop-role.md)
- [shop-verification](shop-verification.md)
- [tenant-setting](tenant-setting.md)
- [tenant](tenant.md)
- [x-shop-id-header](x-shop-id-header.md)
<!-- used-by:end -->
