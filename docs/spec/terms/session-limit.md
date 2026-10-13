---
id: session-limit
title: session_limit revocation reason
kind: term
status: draft
aliases: [session_limit]
defined_for: S01-auth-sessions
rules_hash: a505a24fc6dc
---
# session_limit revocation reason
## Definition
`session_limit` is the [revocation reason](session-revocation.md) recorded when a new login would take a user over the maximum number of [active sessions](session-lifetime.md). The login still succeeds. The user's oldest active session is revoked with this reason, and its [refresh token](token-refresh.md) stops working. [`SessionIssuer`](session-issuer.md) applies the limit when it creates a session.

## Example
A user already has 20 active sessions and logs in from a new laptop. The login creates a session, and the oldest session is revoked with reason `session_limit`.

## Known gaps
- The spec does not say whether "oldest" means the earliest [`createdAt`](session-created-at.md) or the least recent [`lastUsedAt`](session-last-used-at.md).
- The spec does not say whether the user is told about the revocation. Revoked sessions do not appear in `GET /auth/sessions`.

## Used by
<!-- used-by:start -->
- [post-auth-logout](post-auth-logout.md)
- [session-issuer](session-issuer.md)
- [session-last-used-at](session-last-used-at.md)
- [session-lifetime](session-lifetime.md)
- [session-revocation](session-revocation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
