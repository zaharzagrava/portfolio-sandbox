---
id: invite-lifecycle
title: Invite lifecycle
kind: term
status: draft
aliases: [acceptance, expiry, revocation]
defined_for: S03-shops-rbac
rules_hash: d3afa2936134
---
# Invite lifecycle
## Definition
The [invite](pending-invite.md) lifecycle is the set of states an invite passes through, from creation to its end. A [manager](invite-manager.md) creates it with `POST /shops/:shopId/invites`. A pending invite can be [renewed (resend)](invite-resend.md), [revoked](invite-revoke.md), accepted with its [token](invite-token.md), or left to expire. Accepting, revoking and expiring all end the invite. The token can be used only once, and every failed acceptance gives the same [`404 invite_not_found`](invite-not-found.md). While an invite is pending and unexpired, it takes up a [seat](seat.md).

## Example
1. An admin runs `POST /shops/:shopId/invites` for a [`STAFF` role](shop-role.md). The invite is pending and holds a seat.
2. The admin runs `POST .../invites/:inviteId/resend`, which renews it.
3. The invited person runs `POST /shop-invites/accept` with the token. The invite is now accepted. Trying the same token again gives `404 invite_not_found`.

## Known gaps
- The spec does not say how long an invite stays valid, or how much a resend extends it.
- The spec does not say whether a resend issues a new token and makes the old one stop working.
- The spec does not say whether a revoked or expired invite can be brought back, or whether it must be created again.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-27
- [invite-manager](invite-manager.md)
- [invite-resend](invite-resend.md)
- [invite-revoke](invite-revoke.md)
- [invite-token](invite-token.md)
- [pending-invite](pending-invite.md)
- [seat](seat.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
