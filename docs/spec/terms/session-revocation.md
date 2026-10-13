---
id: session-revocation
title: Session revocation
kind: term
status: draft
aliases: [revoke the session, revoked]
defined_for: access-token-session
rules_hash: 6d36ea02873f
---
# Session revocation
## Definition
Session revocation ends a session before its natural end, so its [refresh token](token-refresh.md) can no longer be exchanged. [S01](../capabilities/S01-auth-sessions.md) performs it and offers it to other domains. Revocation also happens automatically when someone presents a refresh token that was already exchanged once. [Access tokens](access-token.md) already issued for the session are not all cut off at once. Routes that guard high-risk actions reject them right away, but an ordinary route keeps accepting them until their [`exp` ↗](../sw-external-terms.md#jwt-exp).

## Example
A user's session is revoked while their access token still has 200 s left (illustrative).
- On a sensitive route, the next request with that token is rejected.
- On an ordinary route, the same token keeps working until its `exp`, then stops.

## Known gaps
- The spec does not say which routes count as "sensitive", or how a sensitive route learns about a revocation so quickly.
- The spec does not say how other domains ask S01 to revoke a session (no endpoint or message is named).
- The spec does not say what status or body a sensitive route returns for a revoked session's token.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-17, R-26, R-38, R-40, B-11, B-18, B-26, B-27
- [S03](../capabilities/S03-shops-rbac.md): R-25, B-08
- [S13](../capabilities/S13-payment-intents.md): R-26
- [W01](../capabilities/W01-auth-account.md): R-17
- [access-token-session](../concepts/access-token-session.md): C-04
- [access-token](access-token.md)
- [directory-row](directory-row.md)
- [firewall-route](firewall-route.md)
- [get-auth-sessions](get-auth-sessions.md)
- [get-payments](get-payments.md)
- [internal-endpoint](internal-endpoint.md)
- [invalid-refresh-token-error](invalid-refresh-token-error.md)
- [invalid-token-error](invalid-token-error.md)
- [membership-removal-source](membership-removal-source.md)
- [password-changed-event](password-changed-event.md)
- [password-reset-token](password-reset-token.md)
- [platform-admin](platform-admin.md)
- [post-auth-logout](post-auth-logout.md)
- [protected-route](protected-route.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [sensitive-route](sensitive-route.md)
- [session-last-used-at](session-last-used-at.md)
- [session-limit](session-limit.md)
- [session-not-found](session-not-found.md)
- [soft-delete](soft-delete.md)
- [spent-token](spent-token.md)
- [token-exchange](token-exchange.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
