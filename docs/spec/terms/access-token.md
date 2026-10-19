---
id: access-token
title: Access token
kind: term
status: draft
aliases: [token]
defined_for: access-token-session
rules_hash: 18bfa5645e38
---
# Access token
## Definition
An access token is a short-lived credential, signed by S01, that proves who the caller is. Any service can check it with the [JWKS public keys ↗](../sw-external-terms.md#jwks) that S01 publishes. The service learns who is calling only from the verified token, never from caller-supplied request headers. Each access token belongs to a session and is swapped for a new one when it expires. Browsers never hold one: [the BFF ↗](../sw-external-terms.md#bff) keeps it on the server behind the [session cookie](session-cookie.md).

## Example
A request carries the token in the only header allowed for it:
```
Authorization: Bearer eyJhbGciOi...   (illustrative value)
```
If the token says [`alg: none` ↗](../sw-external-terms.md#jwt-alg), has an unknown [`kid` ↗](../sw-external-terms.md#jwt-kid), or its time is outside the [5 s tolerance](clock-skew-tolerance.md), the service answers [`401 invalid_token`](invalid-token-error.md). All of these failures get the same response body. A valid token stops working 300 s after it is issued.

## Known gaps
- The spec does not say which token claim (for example [`sub` ↗](../sw-external-terms.md#jwt-sub)) holds the principal, or which other claims the token carries.
- The spec does not make it a rule that a role change takes effect only at the next refresh. Only S01 AS-28 says this, so a token can carry an old role until it expires.
- The spec does not say how a [sensitive route](sensitive-route.md) finds out right away that a [session was revoked](session-revocation.md).

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-01
- [J03](../capabilities/J03-launch-day.md): R-05
- [S01](../capabilities/S01-auth-sessions.md): R-32, B-01, B-10
- [S48](../capabilities/S48-bff.md): R-13, B-18
- [W01](../capabilities/W01-auth-account.md): R-01
- [admission-token](admission-token.md)
- [allowed-callers-decorator](allowed-callers-decorator.md)
- [booking-hold](booking-hold.md)
- [chat-unread](chat-unread.md)
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [current-session-marker](current-session-marker.md)
- [edge-stripping](edge-stripping.md)
- [host-access-cookie](host-access-cookie.md)
- [identity-headers](identity-headers.md)
- [internal-endpoint](internal-endpoint.md)
- [invalid-token-error](invalid-token-error.md)
- [logout-all](logout-all.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [page-upstream-sections](page-upstream-sections.md)
- [post-auth-logout](post-auth-logout.md)
- [post-auth-refresh](post-auth-refresh.md)
- [post-bff-session-refresh](post-bff-session-refresh.md)
- [principal](principal.md)
- [protected-route](protected-route.md)
- [sensitive-route](sensitive-route.md)
- [service-auth-guard](service-auth-guard.md)
- [service-to-service-token](service-to-service-token.md)
- [session-controller](session-controller.md)
- [session-cookie](session-cookie.md)
- [session-id](session-id.md)
- [session-revocation-service](session-revocation-service.md)
- [session-revocation](session-revocation.md)
- [signing-key-states](signing-key-states.md)
- [stock-jwt-verifier](stock-jwt-verifier.md)
- [token-exchange](token-exchange.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
