---
id: session-id
title: sessionId
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: cc4037b6e1e7
---
# sessionId
## Definition
`sessionId` identifies one login session of a user in the identity domain. Every login creates a new `sessionId`. A [token refresh](token-refresh.md) keeps the same `sessionId` and only replaces the tokens. Each entry of [`GET /auth/sessions`](get-auth-sessions.md) carries one, and `DELETE /auth/sessions/:sessionId` uses it to revoke that session. A `sessionId` that belongs to another user gets the same answer as an unknown one, so the route does not reveal other users' sessions.

## Example
```
GET /auth/sessions          → [{"sessionId": "s_9f2c", ..., "current": true}]
DELETE /auth/sessions/s_9f2c   → revokes that session ([sensitive route](sensitive-route.md))
DELETE /auth/sessions/s_other  → 404 session_not_found  (another user's ID, same as an unknown one)
```
(The `sessionId` values are illustrative.)

The [CSRF token ↗](../sw-external-terms.md#csrf-token) is a random part plus a [keyed MAC ↗](../sw-external-terms.md#message-authentication-code) over the `sessionId`. That is why a CSRF token issued for one session is rejected with [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token) on another session.

## Known gaps
- The spec does not say what format a `sessionId` has or how it is generated.
- The spec does not say whether the [access token](access-token.md) carries the `sessionId` as a claim. The sensitive-route check needs to link a token to its session somehow.
- The spec does not say what status `DELETE /auth/sessions/:sessionId` returns on success. It gives `204` only for logout.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [session-not-found](session-not-found.md)
- [token-exchange](token-exchange.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
