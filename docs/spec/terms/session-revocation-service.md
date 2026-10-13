---
id: session-revocation-service
title: SessionRevocationService
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# SessionRevocationService
## Definition
`SessionRevocationService` is a service that the [identity domain](identity-domain.md) exports so that other domains can end user sessions. When a session is revoked, it is stored with a reason. After that, a [sensitive route](sensitive-route.md) rejects the session's [access token](access-token.md) at once. An ordinary route keeps accepting the token until its [`exp`](soft-expiry.md). Other domains call this service so they never change [S01](../capabilities/S01-auth-sessions.md)'s session data directly. This is design intent (not stated in the spec).

## Example
A session moves from active to revoked with one of these reasons: `logout`, `refresh_token_reuse`, `session_limit`, `password_reset`, `admin_ban`.
Illustrative: another domain bans a user and calls `SessionRevocationService`. The user's sessions end with reason `admin_ban`. Their next call to a sensitive route gets `401`, while ordinary routes accept the old token until `exp` (300 s).

## Known gaps
- The spec does not say what methods `SessionRevocationService` has, what arguments they take, or which code file holds it.
- The spec does not say whether the service revokes one session, all of a user's sessions, or both.
- The spec does not say which domains call it, or which revocation reasons a caller may pass.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [identity-domain](identity-domain.md)
- [sensitive-route](sensitive-route.md)
<!-- used-by:end -->
