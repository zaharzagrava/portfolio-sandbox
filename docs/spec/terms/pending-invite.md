---
id: pending-invite
title: Pending invite
kind: term
status: draft
aliases: [invite, invites]
defined_for: tenant-shop-rbac
rules_hash: 837d6a26b032
---
# Pending invite
## Definition
A pending invite asks someone to join a shop's team. It stays pending until the person accepts it or it expires. While it is unexpired, it takes up one of the shop's paid places on the team, just like a member does, so it counts toward the [plan limit](plan-limit.md). Once it expires, it stops taking up that place.

## Example
An [`ADMIN`](shop-role.md) of a [`PRO`](plan-limit.md) shop invites a new `STAFF` user. Until that invite is accepted or expires, the shop's seats used = members + 1.

## Known gaps
- The spec does not say how long an invite stays valid before it expires.
- The spec does not say whether an invite can be revoked to free its seat, or what happens to it on acceptance.
- The spec does not say whether the [role rules for managing members](role-permission-matrix.md) also apply to sending invites. For example, it does not say whether an `ADMIN` may invite an `OWNER`.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-17, B-09, B-13
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-08
- [already-member](already-member.md)
- [invite-manager](invite-manager.md)
- [invite-resend](invite-resend.md)
- [invite-revoke](invite-revoke.md)
- [invite-token](invite-token.md)
- [membership-query-service](membership-query-service.md)
- [plan-limit](plan-limit.md)
- [role-permission-matrix](role-permission-matrix.md)
- [seat](seat.md)
- [shop-member](shop-member.md)
- [shop-tenant](shop-tenant.md)
- [subscription-plan-changed-event](subscription-plan-changed-event.md)
<!-- used-by:end -->
