---
id: content-security-policy
title: Content Security Policy (policy)
kind: term
status: draft
aliases: [csp, policy]
defined_for: W07-app-shell
rules_hash: 82f0327d26eb
---
# Content Security Policy (policy)
## Definition
The policy is the [`Content-Security-Policy` header ↗](../sw-external-terms.md#content-security-policy) that every HTML response of the web app carries. [`buildCsp`](build-csp.md) builds it and [the proxy](web-proxy.md) applies it, with a fresh [nonce ↗](../sw-external-terms.md#csp-nonce) for each response. It is enforced, not [report-only ↗](../sw-external-terms.md#csp-report-only), from the first release. [Payment provider hosts](payment-provider-hosts.md) are added only on `/checkout/pay/*`, and map tile hosts are never wildcards. Because each response needs its own nonce, no route is served from a prerendered or CDN-cached HTML shell.

## Example
```
GET /checkout/pay/abc123                       (illustrative path)
Content-Security-Policy: ... 'nonce-Zx81...' ... <payment provider hosts> ...   (illustrative)

GET /terms
Content-Security-Policy: ... 'nonce-Q4tb...' ...   (no payment provider hosts)
```

## Known gaps
- The spec does not list the directives or their values. It also does not say which configuration values feed the policy, beyond the payment provider hosts and map tile hosts.
- Not confirmed in the code: that the `Reporting-Endpoints` header points browsers to `POST /api/csp-reports`.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-11
- [payment-provider-hosts](payment-provider-hosts.md)
- [web-proxy](web-proxy.md)
<!-- used-by:end -->
