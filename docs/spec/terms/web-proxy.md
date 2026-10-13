---
id: web-proxy
title: Proxy (web proxy)
kind: term
status: draft
aliases: [proxy]
defined_for: W07-app-shell
rules_hash: 6dbb63341465
---
# Proxy (web proxy)
## Definition
The proxy is the web app's request-time hook in `packages/web/proxy.ts`. It runs on every document request, before the page is sent. It applies the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy), with a fresh [nonce ↗](../sw-external-terms.md#csp-nonce) for each response, and adds the [`Reporting-Endpoints` ↗](../sw-external-terms.md#reporting-endpoints) header. It does not build the policy: [one pure function builds it](build-csp.md), and the proxy only applies it. That way the policy is defined in one place.

## Example
A visitor opens `/terms`. The proxy runs on that document request, and the HTML response leaves with a `Content-Security-Policy` header holding a new nonce and a `Reporting-Endpoints` header. A second request to `/terms` gets a different nonce.

## Known gaps
- The spec does not say whether the proxy also sets the [static security headers](static-security-headers.md) (`X-Content-Type-Options`, `X-Frame-Options`) or the `Cache-Control: no-store` of signed-in areas. Those are defined in `packages/web/lib/security/headers.ts`, but the spec does not name the code that applies them.
- The spec does not say which requests count as "document requests". It also does not say whether the proxy skips API calls, images or static files.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-11
- [build-csp](build-csp.md)
- [content-security-policy](content-security-policy.md)
- [static-security-headers](static-security-headers.md)
<!-- used-by:end -->
