---
id: oidc-callback
title: OIDC callback
kind: term
status: draft
aliases: [callback response]
defined_for: S02-mfa-oidc
rules_hash: 9955f8bfc849
---
# OIDC callback
## Definition
The OIDC callback is the endpoint Google redirects the browser back to after sign-in, `GET /auth/oidc/:provider/callback`: it checks the [`state`](oidc-state.md), exchanges the [authorization code ↗](../sw-external-terms.md#authorization-code) for an [ID token ↗](../sw-external-terms.md#oidc-id-token), validates that token, and then signs in, creates or links the user. Every outcome, success or failure, is a redirect to the front-end origin, and the redirect never carries a token, code, `state` or e-mail. A failure sends only an error code taken from a fixed list, so provider text never reaches the user. The code exchange is never retried because it is not [idempotent ↗](../sw-external-terms.md#idempotency), and no provider call happens inside a [database transaction ↗](../sw-external-terms.md#database-transaction).

## Example
The provider returns `access_denied`, so the callback answers:
```
HTTP/1.1 302 Found
Location: /login?error=oidc_denied
Cache-Control: no-store
Referrer-Policy: no-referrer
```
After explicit linking by a signed-in user, the redirect carries `?linked=google` and no new session is issued.

## Known gaps
- The spec does not list the full closed set of callback error codes. Codes seen in the facts: `oidc_denied`, `oidc_exchange_failed`, `oidc_provider_unavailable`, `email_not_verified`, `link_conflict`, `account_unavailable`.
- The spec does not say which front-end path a successful login redirects to when no return path was given.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-18, B-10, B-18
- [account-unavailable](account-unavailable.md)
- [closed-error-code](closed-error-code.md)
- [email-not-verified](email-not-verified.md)
- [email-verified](email-verified.md)
- [federated-identity](federated-identity.md)
- [front-end-origin](front-end-origin.md)
- [link-conflict](link-conflict.md)
- [linked-query-param](linked-query-param.md)
- [oauth-callback](oauth-callback.md)
- [oidc-account-link](oidc-account-link.md)
- [oidc-flow-cookie](oidc-flow-cookie.md)
- [oidc-issuer](oidc-issuer.md)
- [oidc-login-error](oidc-login-error.md)
- [oidc-provider-not-found](oidc-provider-not-found.md)
- [oidc-provider-unavailable](oidc-provider-unavailable.md)
- [oidc-state](oidc-state.md)
- [parse-return-path](parse-return-path.md)
- [return-to](return-to.md)
<!-- used-by:end -->
