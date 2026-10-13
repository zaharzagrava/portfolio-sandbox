---
id: oidc-flow-cookie
title: OIDC flow cookie
kind: term
status: draft
aliases: [flow, flow cookie]
defined_for: S02-mfa-oidc
rules_hash: 64f49e82b9b9
---
# OIDC flow cookie
## Definition
The OIDC flow cookie, `__Host-oidc-flow`, is set by [`POST /auth/oidc/:provider/start`](oidc-start.md) and ties a sign-in flow to the browser that started it. When the provider redirects back, [the callback](oidc-callback.md) checks that the returned [`state`](oidc-state.md) belongs to this browser's flow. A `state` that is missing, unknown, expired, replayed or not bound to the browser is rejected. This binding stops an attacker from completing their own flow in a victim's browser ([login CSRF ↗](../sw-external-terms.md#csrf-token)): design intent (not stated in the spec).

## Example
A visitor calls `POST /auth/oidc/google/start` and receives a `Set-Cookie: __Host-oidc-flow=…` header along with the [`authorizationUrl`](authorization-url.md). If the callback arrives later in a different browser that does not have this cookie, the `state` is browser-unbound and the login is refused.

## Known gaps
- The spec does not say what the cookie contains: an opaque flow ID, or the PKCE verifier and nonce themselves.
- The spec does not say whether the callback clears the cookie.
- The spec does not say which error code the redirect carries when the `state` is rejected.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-09
- [oidc-callback](oidc-callback.md)
- [oidc-start](oidc-start.md)
- [oidc-state](oidc-state.md)
- [static-provider-configuration](static-provider-configuration.md)
<!-- used-by:end -->
