---
id: static-security-headers
title: Static security headers
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 52b3cba349db
---
# Static security headers
## Definition
The static security headers are a fixed set of HTTP headers that every response of the web app carries. Unlike the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy), they are the same on every response and have no per-response [nonce ↗](../sw-external-terms.md#csp-nonce). They include [`X-Content-Type-Options: nosniff` ↗](../sw-external-terms.md#x-content-type-options) and [`X-Frame-Options: DENY` ↗](../sw-external-terms.md#x-frame-options). `staticSecurityHeaders` in the [security headers module](security-headers-module.md) defines them.

## Example
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

## Known gaps
- The spec does not give the full list. It only says the set includes these two headers.
- The spec does not say whether responses of the [backend API](backend-api.md) also carry these headers, or only responses of the web app.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-18
- [backend-api](backend-api.md)
- [no-store-paths](no-store-paths.md)
- [security-headers-module](security-headers-module.md)
- [web-proxy](web-proxy.md)
<!-- used-by:end -->
