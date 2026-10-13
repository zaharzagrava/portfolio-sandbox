---
id: invite-manager
title: Manager (invite management)
kind: term
status: draft
aliases: [managers]
defined_for: S03-shops-rbac
rules_hash: 602ab492bff4
---
# Manager (invite management)
## Definition
A manager is a [shop member](shop-member.md) who may handle the shop's [invites](pending-invite.md): create, list, resend and revoke them. Creating an invite requires the [`members.manage`](permission.md) permission. The spec uses "manager" for the person who revokes or resends a [pending invite](pending-invite.md). Design intent (not stated in the spec): the same permission covers every invite action.

## Example
An [`ADMIN`](shop-role.md) of a shop holds `members.manage`. They call `DELETE /shops/:shopId/invites/:inviteId` to cancel an invite they sent by mistake, and get `204`.

## Known gaps
- The spec does not say which permission is checked for resend, revoke or listing invites. Only creating an invite is explicitly tied to `members.manage`.
- The spec does not say whether an `ADMIN` can revoke an invite created by an `OWNER`, or whether the invited role matters here.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-13
- [invite-resend](invite-resend.md)
- [invite-revoke](invite-revoke.md)
- [invite-token-digest](invite-token-digest.md)
- [pending-invite](pending-invite.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
