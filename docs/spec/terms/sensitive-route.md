---
id: sensitive-route
title: Sensitive route
kind: term
status: draft
aliases: [ordinary route, sensitive routes]
defined_for: access-token-session
rules_hash: 65ef8f0f6c35
---
# Sensitive route
## Definition
A sensitive route is an endpoint that rejects a [revoked session's access token](session-revocation.md) right away. It does not wait for the token to expire. Ordinary routes keep accepting such a token until its [`exp`](soft-expiry.md). Design intent (not stated in the spec): only high-risk actions pay for the extra revocation check.

## Example
A user revokes a session. For up to 300 s, an ordinary route still accepts that session's access token. A sensitive route rejects it on the next request.

## Known gaps
- The spec does not list which routes are sensitive or how a route is marked as sensitive.
- The spec does not say how a sensitive route learns about a revocation, for example by calling [S01](../capabilities/S01-auth-sessions.md) on each request or through a pushed [revocation list](session-revocation.md).
- The spec does not say what status code and body a sensitive route returns for a revoked session.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-17, R-44, B-14
- [access-token-session](../concepts/access-token-session.md): C-04
- [access-token](access-token.md)
- [authorization-cache](authorization-cache.md)
- [get-auth-sessions](get-auth-sessions.md)
- [invalid-token-error](invalid-token-error.md)
- [logout-all](logout-all.md)
- [platform-admin](platform-admin.md)
- [post-auth-logout](post-auth-logout.md)
- [protected-route](protected-route.md)
- [session-revocation-service](session-revocation-service.md)
- [session-revocation](session-revocation.md)
- [shop-cell-move](shop-cell-move.md)
<!-- used-by:end -->
