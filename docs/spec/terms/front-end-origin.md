---
id: front-end-origin
title: Front-end origin
kind: term
status: draft
aliases: [front end origin]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# Front-end origin
## Definition
The front-end origin is the configured scheme, host and port of the web front end. Every [OIDC callback](oidc-callback.md) response is a redirect to this origin, for success and for failure. It is part of the OIDC configuration, together with the Google client settings and the [redirect URI ↗](../sw-external-terms.md#redirect-uri). It is validated in `config-rules.ts`. Design intent (not stated in the spec): a fixed, configured target means a request can never choose where the callback sends the browser.

## Example
After a failed Google login, the callback answers like this (the origin value is illustrative):
```
HTTP/1.1 302 Found
Location: https://shop.example/login?error=oidc_denied
[Cache-Control ↗](../sw-external-terms.md#cache-control): no-store
[Referrer-Policy ↗](../sw-external-terms.md#referrer-policy): no-referrer
```

## Known gaps
- The spec does not say how the front-end origin and the [return path](return-path.md) are joined to build the final redirect URL.
- The spec does not say whether the front-end origin is the same value as the [origin allow-list](origin-allow-list.md) that the [OIDC start](oidc-start.md) and verify endpoints check.
- The spec does not say whether more than one front-end origin can be configured.

## Used by
<!-- used-by:start -->
- [cookie-delivery](cookie-delivery.md)
- [linked-query-param](linked-query-param.md)
- [oauth-callback](oauth-callback.md)
- [oidc-callback](oidc-callback.md)
- [oidc-login-error](oidc-login-error.md)
- [oidc-start](oidc-start.md)
- [origin-allow-list](origin-allow-list.md)
- [return-path](return-path.md)
- [web-rewrite](web-rewrite.md)
<!-- used-by:end -->
