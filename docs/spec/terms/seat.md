---
id: seat
title: Seat
kind: term
status: draft
aliases: [seats]
defined_for: tenant-shop-rbac
rules_hash: da9f0ecf371e
---
# Seat
## Definition
A seat is one place in a shop's team. A shop uses one seat for each current member and one for each [unexpired](pending-invite.md) [pending invite](pending-invite.md). The number of seats used must never go above the shop's [plan limit](plan-limit.md). Expired invites do not use a seat.

## Example
A [`STARTER`](plan-limit.md) shop has 3 members and 2 unexpired pending invites, so it uses 5 seats. Sending one more invite would exceed the `STARTER` limit of 5, so it must be refused.

## Known gaps
- The spec does not say which error code or HTTP status is returned when an action would exceed the seat count.
- The spec does not say whether seats are checked when an invite is sent, when it is accepted, or both.
- The spec does not say what happens to existing members when a shop moves to a plan with fewer seats.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-17
- [tenant-shop-rbac](../concepts/tenant-shop-rbac.md): C-08
- [already-member](already-member.md)
- [invite-revoke](invite-revoke.md)
- [max-owned-shops](max-owned-shops.md)
- [pending-invite](pending-invite.md)
- [plan-limit](plan-limit.md)
- [sandbox-shop](sandbox-shop.md)
- [shop-member](shop-member.md)
- [shop-role](shop-role.md)
- [shop-tenant](shop-tenant.md)
- [subscription-plan-changed-event](subscription-plan-changed-event.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
