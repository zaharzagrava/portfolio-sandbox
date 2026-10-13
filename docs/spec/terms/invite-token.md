---
id: invite-token
title: Invite token
kind: term
status: draft
aliases: [invite tokens]
defined_for: S03-shops-rbac
rules_hash: 0a747ab84673
---
# Invite token
## Definition
An invite token is the secret a person needs to accept a [pending invite](pending-invite.md) to join a [shop](shop-tenant.md). The database never stores the token itself, only a one-way fingerprint of it created by `digestInviteToken`. A token works only once, and no API response contains it, including the response to the call that created the invite. Sending an invite again issues a new token and makes the old one stop working, and cancelling an invite makes its token stop working.

## Example
`POST /shops/:shopId/invites` answers `201` with the lower-cased address and an expiry 7 days ahead, but with no token.
The invitee later sends the token to `POST /shop-invites/accept`. If a second request uses the same token, it answers `404 invite_not_found`.

## Known gaps
- Not confirmed in the code: the token is delivered to the invitee in the message on the `tenancy-invite-requested` queue. The spec only says this queue carries "the invite message".
- The spec does not say which digest algorithm is used, or how long and how random the token is.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-14, B-09, B-11, B-13
- [get-shop-export](get-shop-export.md)
- [invite-acceptance](invite-acceptance.md)
- [invite-lifecycle](invite-lifecycle.md)
- [invite-resend](invite-resend.md)
- [invite-revoke](invite-revoke.md)
- [invite-token-digest](invite-token-digest.md)
- [malformed-queue-message](malformed-queue-message.md)
- [pending-invite](pending-invite.md)
- [shop-tenant](shop-tenant.md)
- [template-redaction](template-redaction.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
<!-- used-by:end -->
