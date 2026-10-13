---
id: invite-token-digest
title: Invite token digest
kind: term
status: draft
aliases: [digestinvitetoken]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# Invite token digest
## Definition
The [invite token](invite-token.md) digest is the only form of an invite token that the system stores. The database keeps the digest and never the raw token. `digestInviteToken` computes the digest. Because only the digest is stored, someone who reads the database cannot use what they find to accept an invite. This is design intent (not stated in the spec). The raw token also never appears in any API response.

## Example
A [manager](invite-manager.md) sends [`POST /shops/:shopId/invites`](invite-resend.md) to invite `" New@Mail.com "` as `VIEWER`. The answer is `201` with `new@mail.com` and an expiry 7 days ahead, but no token. Only the digest is stored.
The invitee sends the token to `POST /shop-invites/accept`, and the invite is accepted. Sending the same token again answers [`404 invite_not_found`](invite-not-found.md).

## Known gaps
- The spec does not say which digest algorithm `digestInviteToken` uses. It also does not say whether a secret key or [salt ↗](../sw-external-terms.md#salted-hash) goes into the digest.
- Not confirmed in the code: acceptance finds the invite by computing the digest of the token it receives and comparing it with the stored digest.
- The spec does not say whether a resend replaces the stored digest or keeps the old one and marks it unusable. It only says that a resend makes the old token stop working.

## Used by
<!-- used-by:start -->
- [invite-manager](invite-manager.md)
- [invite-token](invite-token.md)
<!-- used-by:end -->
