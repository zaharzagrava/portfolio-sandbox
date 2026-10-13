---
id: membership-query-service
title: MembershipQueryService
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# MembershipQueryService
## Definition
`MembershipQueryService` is one of the services that the [tenancy capability (S03)](capability.md) exports for other capabilities to use. Its name suggests it gives read-only answers about shop membership: who belongs to a shop and with which [shop role](shop-role.md). Other capabilities ask it instead of reading the [`ShopMembership` table](shop-membership.md) directly. This is design intent (not stated in the spec). It is exported alongside `ShopAccessService`, `ShopQueryService`, `ShopProvisioningService` and `ShopCellService`.

## Example
Possible use (the facts do not link this read to this service): a user is removed from shop `shop_123` (illustrative id) and then tries to subscribe to `shop:shop_123:live`. The [realtime topic](realtime-topic.md) refuses the subscription because the user is no longer a member.

## Known gaps
- Not confirmed in the code: which methods `MembershipQueryService` exposes, or whether it backs `GET /shops/mine` and `GET /shops/:shopId/members`.
- The spec does not say whether its answers come from the [authorization cache](authorization-cache.md), where entries can be briefly stale, or always from the database.
- The spec does not say whether it counts [pending invites](pending-invite.md) as members. Seat counting includes them; the membership list may not.

## Used by
<!-- used-by:start -->
- [authorization-cache](authorization-cache.md)
- [capability](capability.md)
- [pending-invite](pending-invite.md)
- [realtime-topic](realtime-topic.md)
- [shop-membership](shop-membership.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
