---
id: shop-member
title: Shop member
kind: term
status: draft
aliases: [member, members]
defined_for: S03-shops-rbac
rules_hash: 0bff6b52b652
---
# Shop member
## Definition
A shop member is a user who belongs to a shop and holds exactly one [shop role](shop-role.md) in it. Each membership is a row in the [`ShopMembership` table](shop-membership.md). Only members can read the shop, its members and its [`shop:<shopId>:live` topic](realtime-topic.md). A non-member gets the same [`shop_not_found`](shop-not-found.md) answer as for a shop that does not exist. Members count toward the shop's [seats](seat.md).

## Example
A user who sends [`POST /shops`](post-shops.md) becomes the `OWNER` member of the new shop. Someone who accepts an [invite](pending-invite.md) through `POST /shop-invites/accept` becomes a member with the invited role. `DELETE /shops/:shopId/members/:userId` removes a member, or lets a member leave.

## Known gaps
- The spec does not say whether a member of a `SUSPENDED` or `DELETING` shop keeps access beyond the permissions the [status gate](shop-status-gate.md) allows.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-03
- [already-member-flag](already-member-flag.md)
- [checkout-review-step](checkout-review-step.md)
- [invite-acceptance](invite-acceptance.md)
- [invite-manager](invite-manager.md)
- [member-view](member-view.md)
- [pending-invite](pending-invite.md)
- [realtime-topic](realtime-topic.md)
- [seat](seat.md)
- [shop-membership](shop-membership.md)
- [shop-role](shop-role.md)
- [shop-search-table](shop-search-table.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
