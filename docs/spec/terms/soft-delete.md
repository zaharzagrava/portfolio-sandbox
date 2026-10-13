---
id: soft-delete
title: Soft delete
kind: term
status: draft
aliases: [soft-deleted]
defined_for: S01-auth-sessions
rules_hash: 6f8892d6b4cc
---
# Soft delete
## Definition
A soft-deleted user is an account marked as deleted while its record stays in storage. The system treats such a user as gone. Their [refresh token](token-refresh.md) fails with [`invalid_refresh_token`](invalid-refresh-token-error.md) and their [session is revoked](session-revocation.md). User-directory lookups leave them out of the results.

## Example
User C is soft-deleted. When C's client presents its refresh token to `POST /auth/refresh`, the response is `401 invalid_refresh_token` and C's session is revoked. When another domain calls [`getUsersByIds([A, B, C])`](get-users-by-ids.md), C is not in the returned map.

## Known gaps
- The spec does not say how a soft delete is stored, what triggers it, or whether it can be undone.
- The spec does not say whether [`findByEmail`](find-by-email.md) returns `null` for a soft-deleted user.
- The spec does not say whether an access token that is still valid keeps working on an ordinary route after the user is soft-deleted.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-13
- [S53](../capabilities/S53-events-projections.md): B-08
- [find-by-email](find-by-email.md)
- [get-users-by-ids](get-users-by-ids.md)
- [invalid-credentials](invalid-credentials.md)
- [session-revocation](session-revocation.md)
- [soft-deleted-user](soft-deleted-user.md)
- [token-refresh](token-refresh.md)
- [user-summary](user-summary.md)
<!-- used-by:end -->
