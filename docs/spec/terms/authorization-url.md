---
id: authorization-url
title: authorizationUrl
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# authorizationUrl
## Definition
`authorizationUrl` is the field in the response from `POST /auth/oidc/:provider/start` that holds the provider's sign-in address for this flow. The URL includes the [PKCE challenge ↗](../sw-external-terms.md#pkce) and the flow's [`state`](oidc-state.md). The front end sends the browser to this URL, and the provider then redirects back to `GET /auth/oidc/:provider/callback`. The start call returns the URL and does not redirect itself, probably so that the call can be [origin-checked](origin-allow-list.md) ([`403 origin_not_allowed`](origin-not-allowed.md)): design intent (not stated in the spec).

## Example
```json
{ "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&code_challenge=…&code_challenge_method=S256&state=…" }
```
All parameter values are illustrative.

## Known gaps
- The spec does not list the exact query parameters (for example [`nonce` ↗](../sw-external-terms.md#oidc-nonce), `scope` or the challenge method), although B-11 implies that a `nonce` is checked.

## Used by
<!-- used-by:start -->
- [origin-allow-list](origin-allow-list.md)
<!-- used-by:end -->
