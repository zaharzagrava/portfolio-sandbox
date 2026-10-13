---
id: already-member
title: already_member (409)
kind: term
status: draft
aliases: [already_member]
defined_for: S03-shops-rbac
rules_hash: ff93e63aba77
---
# already_member (409)
## Definition
`already_member` is a [conflict error](conflict-error.md) that `POST /shops/:shopId/invites` returns when the invited address already belongs to a member of the shop. No invite is created. Its sibling [`409 invite_pending`](invite-pending.md) covers an address that already has a [pending invite](pending-invite.md). Accepting an invite as an existing member is a different case: it answers `200` with [`alreadyMember: true`](already-member-flag.md).

## Example
A manager with [`members.manage`](permission.md) invites an address that is already on the team:
```
POST /shops/:shopId/invites  { "email": "new@mail.com", "role": "VIEWER" }   (body shape illustrative)
→ 409 already_member
```

## Known gaps
- The spec does not say whether the membership check compares the trimmed, lower-cased address, which is how the invite stores it.
- The spec does not say which comes first when an invite breaks several rules at once, such as `already_member`, the [seat limit](seat.md) and the invite rate limit.

## Used by
<!-- used-by:start -->
- [already-member-flag](already-member-flag.md)
- [conflict-error](conflict-error.md)
- [pending-invite](pending-invite.md)
- [seat](seat.md)
<!-- used-by:end -->
