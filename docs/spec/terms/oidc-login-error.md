---
id: oidc-login-error
title: OIDC login error codes
kind: term
status: draft
aliases: [oidc_denied, oidc_exchange_failed, oidc_provider_unavailable]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# OIDC login error codes
## Definition
OIDC login error codes are a [closed set](closed-error-code.md) of short codes that the [OIDC callback](oidc-callback.md) puts in its redirect to the front-end when a Google sign-in fails. The callback always answers with a redirect to the [front-end origin](front-end-origin.md). It never shows an error page and never passes on the provider's own error text. The front-end reads the `error` query parameter and shows its own message. The provider's wording never reaches the user, so the provider cannot inject text into the login page.

## Example
The provider returns `access_denied`, so the callback answers (origin illustrative):
```
HTTP/1.1 302 Found
Location: https://shop.example/login?error=oidc_denied
Cache-Control: no-store
Referrer-Policy: no-referrer
```
Other codes in the spec: `oidc_exchange_failed`, `oidc_provider_unavailable`, `email_not_verified`, `link_conflict`, `account_unavailable`.

## Known gaps
- The spec does not give the complete list of codes, so the six above may not be all of them.
- The spec does not say which code, if any, the callback sends for a rejected [`state`](oidc-state.md) or an [ID token ↗](../sw-external-terms.md#oidc-id-token) that fails validation. It only says "a closed error code".
- The spec does not say that every code goes to `/login`. The path is confirmed only for `oidc_denied`.

## Used by
<!-- used-by:start -->
- [account-unavailable](account-unavailable.md)
- [closed-error-code](closed-error-code.md)
- [front-end-origin](front-end-origin.md)
- [link-conflict](link-conflict.md)
- [oidc-callback](oidc-callback.md)
<!-- used-by:end -->
