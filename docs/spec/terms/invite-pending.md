---
id: invite-pending
title: invite_pending (409)
kind: term
status: draft
aliases: [invite_pending]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# invite_pending (409)
## Definition
`invite_pending` is a conflict error. `POST /shops/:shopId/invites` returns it when the invited address already has a pending invite for the same shop. No second invite is created. To reach that person again, a manager should resend or revoke the existing invite. Its sibling, `already_member`, covers an address that already belongs to a shop member.

## Example
A manager with `members.manage` invites an address that was invited earlier and has not accepted yet:
```
POST /shops/:shopId/invites  { "email": "new@mail.com", "role": "VIEWER" }   (body shape illustrative)
→ 409 invite_pending
```
To give that person a fresh expiry, the manager calls `POST /shops/:shopId/invites/:inviteId/resend` instead.

## Known gaps
- The spec does not say whether an expired invite still blocks a new invite. Expiry comes from time, and seat counting only includes unexpired pending invites.
- The spec does not say whether the check compares the trimmed, lower-cased address, which is how the invite stores it.
- The spec does not say which error wins when an address is both a member and has a pending invite.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
