---
id: invite-revoke
title: Invite revoke
kind: term
status: draft
aliases: [revoked]
defined_for: S03-shops-rbac
rules_hash: 6195e1e93ee3
---
# Invite revoke
## Definition
Revoking cancels a [pending invite](pending-invite.md) before anyone accepts it. A [manager](invite-manager.md) calls `DELETE /shops/:shopId/invites/:inviteId` and gets `204`. After that, the invite's [token](invite-token.md) stops working. Any later accept with that token gets the same [`invite_not_found`](invite-not-found.md) as every other failed accept, so the caller can't tell the invite was revoked. The invite moves to the `revoked` state.

## Example
```
DELETE /shops/shop_123/invites/inv_456   → 204   (ids illustrative)
POST /shop-invites/accept { "token": "<old token>" } → 404 invite_not_found
```

## Known gaps
- The spec does not say whether revoking an invite frees its [seat](seat.md) right away. Seats count unexpired pending invites, so it probably does, but this is not confirmed.
- The spec does not say what happens when you revoke an invite that is already accepted, revoked or expired.
- The spec does not say whether revoking emits an event. Only `tenancy.invite_created` is listed.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-13
- [invite-manager](invite-manager.md)
- [invite-not-found](invite-not-found.md)
- [invite-token](invite-token.md)
- [pending-invite](pending-invite.md)
- [seat](seat.md)
<!-- used-by:end -->
