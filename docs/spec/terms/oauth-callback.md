---
id: oauth-callback
title: OAuth callback
kind: term
status: draft
aliases: [the callback]
defined_for: S02-mfa-oidc
rules_hash: b32faf4a71f3
---
# OAuth callback
## Definition
In this system, the OAuth callback is the same endpoint as the [OIDC callback](oidc-callback.md): `GET /auth/oidc/:provider/callback`. It is the redirect target of the [Authorization Code flow with PKCE ↗](../sw-external-terms.md#pkce), where the provider returns the authorization code and [`state`](oidc-state.md). The system then runs the OIDC checks on the [ID token ↗](../sw-external-terms.md#oidc-id-token). The outcome is always a redirect to the [front-end origin](front-end-origin.md), carrying either success or a [closed error code](closed-error-code.md) such as [`email_not_verified`](email-not-verified.md).

## Example
Google redirects the browser to `/auth/oidc/google/callback?code=…&state=…`. The ID token has `email_verified: false`, so the callback ends with `error=email_not_verified`.

## Known gaps
- The spec does not separate an "OAuth callback" from the OIDC callback. Treat them as one endpoint unless the code shows otherwise.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-21, B-18, B-19
- [closed-error-code](closed-error-code.md)
- [front-end-origin](front-end-origin.md)
- [identity-store](identity-store.md)
- [oidc-callback](oidc-callback.md)
- [soft-deleted-user](soft-deleted-user.md)
<!-- used-by:end -->
