---
id: invite-acceptance
title: Invite acceptance
kind: term
status: draft
aliases: [accept, accepts]
defined_for: S03-shops-rbac
rules_hash: 8a43839051a8
---
# Invite acceptance
## Definition
Invite acceptance is the step where an invited person calls `POST /shop-invites/accept` with their [invite token](invite-token.md) to join [the shop](shop-tenant.md). If it succeeds, they become a [member](shop-member.md) with [the role from the invite](shop-role.md), and that role is never `OWNER`. If the person is already a member, the call succeeds with [`alreadyMember: true`](already-member.md) and their role does not change. Every failure gives the same [`invite_not_found`](invite-not-found.md) answer. Failed attempts are [rate-limited per user](rate-limit.md) and answer `429` with [`Retry-After` ↗](../sw-external-terms.md#retry-after) when the limit is reached.

## Example
```
POST /shop-invites/accept   → 201  (new member)
POST /shop-invites/accept   → 200  {"alreadyMember": true}
```
If two accepts with the same valid token arrive at the same time, one gets `201` and the other gets `404 invite_not_found`.

## Known gaps
- The spec does not say whether the caller must be signed in. It also does not say how "wrong address" is decided, for example by comparing the invite address with the signed-in user's email.
- The spec does not say whether a successful accept emits `tenancy.member_added`.
- The spec does not say whether accepting re-checks the seat limit.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-15, R-18
- [identical-not-found](identical-not-found.md)
- [invite-not-found](invite-not-found.md)
- [invite-token](invite-token.md)
- [rate-limit](rate-limit.md)
- [shop-member](shop-member.md)
- [shop-role](shop-role.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
