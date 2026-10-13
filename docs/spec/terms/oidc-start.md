---
id: oidc-start
title: OIDC start
kind: term
status: draft
aliases: [oidc]
defined_for: S02-mfa-oidc
rules_hash: 74b97031638e
---
# OIDC start
## Definition
`POST /auth/oidc/:provider/start` begins a "Sign in with Google" flow. It creates a [flow record](oidc-state.md) and sets the [`__Host-oidc-flow` cookie](oidc-flow-cookie.md), which ties the flow to this browser. It then returns an [`authorizationUrl`](authorization-url.md) that sends the browser to the provider using [Authorization Code with PKCE ↗](../sw-external-terms.md#pkce). The caller can pass a [`returnTo`](return-to.md) path, which must pass the [return-path rules](return-path.md). The provider must be known, well formed and configured, and the request must come from a web origin the service allows.

## Example
```
POST /auth/oidc/google/start      (provider id illustrative)
Origin: <front-end origin>
{ "returnTo": "/orders" }         (body shape illustrative)
→ 200 { "authorizationUrl": "https://accounts.google.com/..." } + Set-Cookie: __Host-oidc-flow=...
```
An unknown provider gets [`404 oidc_provider_not_found`](oidc-login-error.md), and a foreign `Origin` gets `403 origin_not_allowed`.

## Known gaps
- The spec does not say what start answers when `returnTo` is refused, for example `//evil.example`. It is refused, but the spec gives no status or error code.
- The spec does not say which rate limit policy covers start. The capability owns [`auth.oidc.ip`](rate-limit-policy.md), but this is not confirmed in the code.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-17
- [front-end-origin](front-end-origin.md)
- [get-auth-oidc-providers](get-auth-oidc-providers.md)
- [oidc-flow-cookie](oidc-flow-cookie.md)
- [oidc-state](oidc-state.md)
- [origin-allow-list](origin-allow-list.md)
- [origin-not-allowed](origin-not-allowed.md)
- [parse-return-path](parse-return-path.md)
- [return-path](return-path.md)
- [return-to](return-to.md)
- [static-provider-configuration](static-provider-configuration.md)
<!-- used-by:end -->
