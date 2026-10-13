---
id: session-last-used-at
title: lastUsedAt (session)
kind: term
status: draft
aliases: [lastusedat]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# lastUsedAt (session)
## Definition
`lastUsedAt` is the last time a session was used. Each entry of [`GET /auth/sessions`](get-auth-sessions.md) returns it. Users can read it to spot sessions they no longer use and [revoke](session-revocation.md) them through `DELETE /auth/sessions/:sessionId`. It is a display field. Expiry follows the [refresh-token](token-refresh.md) and [session-lifetime](session-lifetime.md) rules, not this value.

## Example
A user sees a session with `"device": "Chrome on Windows"` and a `lastUsedAt` from weeks ago (illustrative). They call `DELETE /auth/sessions/s_91ab` to revoke it.

## Known gaps
- The spec does not say what updates `lastUsedAt`. It could be each refresh, each authenticated request, or only login.
- The spec does not say whether the [`session_limit` revocation](session-limit.md) picks the "oldest" session by `lastUsedAt` or by `createdAt`.
- The spec does not say what format or precision `lastUsedAt` uses.

## Used by
<!-- used-by:start -->
- [session-lifetime](session-lifetime.md)
- [session-limit](session-limit.md)
- [session-revocation](session-revocation.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
