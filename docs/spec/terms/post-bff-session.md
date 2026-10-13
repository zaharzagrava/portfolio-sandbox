---
id: post-bff-session
title: POST /api/bff/session
kind: term
status: draft
aliases: [/api/bff/session]
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# POST /api/bff/session
## Definition
`POST /api/bff/session` is the sign-in endpoint that the browser calls through the [BFF ↗](../sw-external-terms.md#bff). `SessionController` handles it. The BFF keeps the tokens, stores the [session record](session-store.md) in Redis, and gives the browser only the [session cookie](session-cookie.md) and the [CSRF token cookie ↗](../sw-external-terms.md#csrf-token). If the account has [two-step verification](mfa-state.md), the answer says that a second step is needed. The browser then goes to the [login MFA page](login-mfa-page.md) instead of finishing sign-in. Sign-in is an anonymous flow, so this request has no [`X-CSRF-Token` header ↗](../sw-external-terms.md#csrf-token).

## Example
For an account with two-step verification:
```
HTTP/1.1 200 OK
{"mfaRequired": true}
```
The browser then replaces the current page with `/login/mfa?returnTo=…`. For a wrong password, the answer is `401 invalid_credentials`. For too many attempts, it is [`429 rate_limited`](rate-limited.md) with a `Retry-After` header (for example `Retry-After: 30`, an illustrative value).

## Known gaps
- The spec does not list the request body fields. Sign-in likely sends the e-mail and password, but that is not stated.
- Not confirmed in the code: that a [`mfaRequired`](mfa-challenge.md) answer sets the [`__Host-bff-mfa` cookie](host-bff-mfa-cookie.md) to hold the pending challenge. The cookie exists, but nothing in the facts links it to this answer.
- The spec does not give the body of a successful sign-in without MFA, or which cookies that answer sets.

## Used by
<!-- used-by:start -->
- [host-bff-mfa-cookie](host-bff-mfa-cookie.md)
- [login-mfa-page](login-mfa-page.md)
- [mfa-state](mfa-state.md)
- [session-cookie](session-cookie.md)
- [session-store](session-store.md)
<!-- used-by:end -->
