---
id: origin-not-allowed
title: origin_not_allowed (403)
kind: term
status: draft
aliases: [origin_not_allowed]
defined_for: S02-mfa-oidc
rules_hash: e281a1c38a0c
---
# origin_not_allowed (403)
## Definition
`origin_not_allowed` is the error code returned with `403` when a request's [`Origin` header ↗](../sw-external-terms.md#origin-header) is not one the system accepts. It guards endpoints that start a browser flow or set [session cookies](session-cookie.md): the [OIDC start](oidc-start.md), and [MFA verify](mfa-verify-endpoint.md) with [cookie delivery](cookie-delivery.md). The point is that a foreign website cannot use the user's browser to start a login or receive session cookies: design intent (not stated in the spec).

## Example
```
POST /auth/mfa/verify
Origin: https://evil.example
→ 403  error code: origin_not_allowed
```

## Known gaps
- The spec does not say which origins are allowed. The configured front-end origin is the likely [allow-list](origin-allow-list.md), but this is not confirmed in the code.
- The spec does not say what happens when the `Origin` header is missing, or whether verify checks `Origin` when the token is returned in the body instead of cookies.

## Used by
<!-- used-by:start -->
- [cookie-delivery](cookie-delivery.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [oidc-start](oidc-start.md)
- [origin-allow-list](origin-allow-list.md)
- [session-cookie](session-cookie.md)
<!-- used-by:end -->
