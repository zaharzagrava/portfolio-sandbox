---
id: closed-error-code
title: Closed error code
kind: term
status: draft
aliases: [closed set]
defined_for: S02-mfa-oidc
rules_hash: c10127afeda0
---
# Closed error code
## Definition
A closed error code is a value from the fixed set of codes that an [OIDC callback](oidc-callback.md) failure can place in the `error` query parameter of its [`302` redirect ↗](../sw-external-terms.md#http-302-found). The system never passes the provider's own error text to the user. It maps every failure to one of its own codes. Known codes include [`oidc_denied`](oidc-login-error.md), `oidc_exchange_failed`, `oidc_provider_unavailable`, [`email_not_verified`](email-not-verified.md), [`link_conflict`](link-conflict.md) and [`account_unavailable`](account-unavailable.md).

## Example
The provider returns `access_denied` along with some free text. The callback answers:
```
HTTP/1.1 302
Location: /login?error=oidc_denied
Cache-Control: no-store
Referrer-Policy: no-referrer
```

## Known gaps
- The spec does not give the complete list of codes.
- The spec does not name the code used when ID-token validation fails (wrong `nonce`, `aud` or `iss`, an expired token, a bad signature, or a rejected `alg`).
- The spec does not name the code used for a rejected `state`.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-11
- [email-not-verified](email-not-verified.md)
- [oauth-callback](oauth-callback.md)
- [oidc-callback](oidc-callback.md)
- [oidc-login-error](oidc-login-error.md)
<!-- used-by:end -->
