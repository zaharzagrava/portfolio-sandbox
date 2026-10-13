---
id: invite-resend
title: Invite resend
kind: term
status: draft
aliases: [resend]
defined_for: S03-shops-rbac
rules_hash: 40eede44b93b
---
# Invite resend
## Definition
Resending renews a [pending invite](pending-invite.md). [A manager](invite-manager.md) calls `POST /shops/:shopId/invites/:inviteId/resend`. The invite gets a fresh expiry and a new token, and the old token stops working at once. Like at creation, [the token never appears in the API response](invite-token.md). Design intent (not stated in the spec): the new token reaches the invitee through the [`tenancy-invite-requested` queue](task-row.md).

## Example
An invite to `new@mail.com` is about to expire. The manager resends it, and the expiry resets to 7 days from now. The link in the first email now answers `[404 invite_not_found](invite-not-found.md)`.

## Known gaps
- The spec does not say whether a resend counts toward the shop's hourly invite rate limit.
- The spec does not say whether you can resend an expired or revoked invite, or what the error would be.
- The spec does not say what status code a successful resend returns.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-13, B-26
- [invite-lifecycle](invite-lifecycle.md)
- [invite-manager](invite-manager.md)
- [invite-token](invite-token.md)
- [pending-invite](pending-invite.md)
- [task-row](task-row.md)
<!-- used-by:end -->
