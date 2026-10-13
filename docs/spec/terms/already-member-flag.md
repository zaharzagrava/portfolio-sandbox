---
id: already-member-flag
title: alreadyMember flag
kind: term
status: draft
aliases: [alreadymember]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# alreadyMember flag
## Definition
`alreadyMember` is a flag in the response to [`POST /shop-invites/accept`](invite-acceptance.md). It is true when the person accepting the invite is already a [member of the shop](shop-member.md). The acceptance then succeeds without adding a membership, and the member's current role stays unchanged. This is not the same as the [`already_member` conflict error](already-member.md), which blocks creating the invite in the first place.

## Example
A user who is already [`STAFF`](shop-role.md) in a shop accepts an old invite for that shop:
```
POST /shop-invites/accept  { "token": "<[invite token](invite-token.md)>" }   (body shape illustrative)
→ 200 { "alreadyMember": true, ... }   (role stays STAFF)
```
A normal first-time acceptance answers `201` instead.

## Known gaps
- The spec does not say whether the invite is marked `accepted` (and its token used up) when the flag is true.
- The spec does not say whether a normal `201` acceptance includes `alreadyMember: false` or leaves the field out.
- The spec does not say what other fields the `200` response contains.

## Used by
<!-- used-by:start -->
- [already-member](already-member.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
