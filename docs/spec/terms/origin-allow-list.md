---
id: origin-allow-list
title: Origin allow-list
kind: term
status: draft
aliases: [allow-list, allowed origins]
defined_for: S02-mfa-oidc
rules_hash: 29c49def6cb8
---
# Origin allow-list
## Definition
The origin allow-list is the set of browser origins that the system accepts in a request's [`Origin` header ↗](../sw-external-terms.md#origin-header). Two kinds of request are checked against it: the [OIDC start](oidc-start.md), and the [MFA verify endpoint](mfa-verify-endpoint.md) when it uses [cookie delivery](cookie-delivery.md). If the origin is not on the list, the request fails with [origin_not_allowed](origin-not-allowed.md). This means a foreign website cannot use the user's browser to start a Google login or to receive session cookies. That reason is design intent (not stated in the spec).

## Example
```
POST /auth/mfa/verify          (cookie delivery)
Origin: https://evil.example
→ 403  origin_not_allowed
```
If the `Origin` is on the list, the same verify request sets three cookies and puts no token in the body.

## Known gaps
- The spec does not say which origins are on the list. It could be the [front-end origin](front-end-origin.md) configured in `config-rules.ts`, but this is not confirmed in the code.
- The spec does not say what happens when the `Origin` header is missing.
- The spec does not say whether verify checks `Origin` when the token comes back in the body instead of in cookies.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-29
- [S48](../capabilities/S48-bff.md): R-18
- [api-bff-endpoints](api-bff-endpoints.md)
- [authorization-url](authorization-url.md)
- [cookie-delivery](cookie-delivery.md)
- [form-alert](form-alert.md)
- [front-end-origin](front-end-origin.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [oidc-start](oidc-start.md)
- [origin-not-allowed](origin-not-allowed.md)
<!-- used-by:end -->
