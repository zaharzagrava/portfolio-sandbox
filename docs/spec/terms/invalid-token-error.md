---
id: invalid-token-error
title: invalid_token error
kind: term
status: draft
aliases: [invalid_token]
defined_for: access-token-session
rules_hash: e3b0c44298fc
---
# invalid_token error
## Definition
`invalid_token` is the single `401` error returned when an [access token](access-token.md) fails verification. Every failure reason gets the same body, so a caller cannot tell which check failed. Design intent (not stated in the spec): this avoids helping an attacker probe the verifier. Refresh failures use a separate error, [`invalid_refresh_token`](invalid-refresh-token-error.md).

## Example
A token with [`alg: none` ↗](../sw-external-terms.md#jwt-alg) and a token with an unknown [`kid` ↗](../sw-external-terms.md#jwt-kid) both get `401 invalid_token` with byte-identical bodies.

## Known gaps
- The spec does not give the exact body shape or say whether a [`WWW-Authenticate` header ↗](../sw-external-terms.md#www-authenticate) is sent.
- The spec does not say whether a missing token, or an expired token on an ordinary route, gets the same response.
- The spec does not say what error a [sensitive route](sensitive-route.md) returns for a [revoked session](session-revocation.md)'s token.

## Used by
<!-- used-by:start -->
- [access-token](access-token.md)
- [sensitive-route](sensitive-route.md)
- [session-revocation](session-revocation.md)
<!-- used-by:end -->
