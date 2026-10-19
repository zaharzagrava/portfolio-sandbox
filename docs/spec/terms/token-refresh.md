---
id: token-refresh
title: Token refresh
kind: term
status: draft
aliases: [exchange, refresh token]
defined_for: access-token-session
rules_hash: b8759ec8cab3
---
# Token refresh
## Definition
A token refresh is the exchange in which a caller hands [S01](../capabilities/S01-auth-sessions.md) its refresh token and gets a new token back for the same session. The old refresh token is spent and can't be used again. Refresh lets a client keep a session going past one [access token](access-token.md)'s short life without signing in again. A role change only takes effect at the next refresh (S01 AS-28). In browsers, the [BFF ↗](../sw-external-terms.md#bff) does the refresh server-side, because the browser never holds a token.

## Example
The BFF finds that the access token for a [`__Host-bff-session` cookie](session-cookie.md) has expired. It sends the stored refresh token to S01, gets a new token for the same session, and stores it. The old refresh token is now spent. If the exchange fails, S01 answers `401 invalid_refresh_token`.

## Known gaps
- The spec does not say which endpoint performs the refresh, or the shape of its request and response.
- The spec does not say whether a refresh returns a new access token, a new refresh token, or both. It says only "a new token for the same session".

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-02
- [S01](../capabilities/S01-auth-sessions.md): R-18, R-21, R-22, R-27, R-31, B-06, B-10, B-19, B-22, B-28
- [S48](../capabilities/S48-bff.md): R-19, B-17
- [W01](../capabilities/W01-auth-account.md): B-19
- [access-token-session](../concepts/access-token-session.md): C-05
- [access-token](access-token.md)
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [host-refresh-cookie](host-refresh-cookie.md)
- [identity-domain](identity-domain.md)
- [logout-all](logout-all.md)
- [oversized-refresh-token](oversized-refresh-token.md)
- [post-auth-logout](post-auth-logout.md)
- [post-auth-refresh](post-auth-refresh.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [session-cookie](session-cookie.md)
- [session-expired](session-expired.md)
- [session-id](session-id.md)
- [session-issuer](session-issuer.md)
- [session-last-used-at](session-last-used-at.md)
- [session-lifetime](session-lifetime.md)
- [session-limit](session-limit.md)
- [session-revocation](session-revocation.md)
- [soft-delete](soft-delete.md)
<!-- used-by:end -->
