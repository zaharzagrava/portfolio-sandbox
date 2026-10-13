---
id: payment-provider-hosts
title: Payment provider hosts (CSP)
kind: term
status: draft
aliases: [payment provider hosts]
defined_for: W07-app-shell
rules_hash: bff0fda714e8
---
# Payment provider hosts (CSP)
## Definition
Payment provider hosts are the external hosts of the payment provider that the browser must be allowed to load content from. They are configured through `PAYMENT_PROVIDER_HOSTS` and added to the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) by [`buildCsp`](build-csp.md). They are added only on [`/checkout/pay/*`](checkout-pay-route.md), and every other page's policy leaves them out. Design intent (not stated in the spec): limiting third-party hosts to the one area that needs them keeps the policy as narrow as possible everywhere else.

## Example
The directive and host names below are illustrative.
```
# response for /checkout/pay/123
Content-Security-Policy: … frame-src 'self' https://pay.provider.example …
# response for /search: no payment provider host anywhere in the policy
```

## Known gaps
- The spec does not say which [CSP directives ↗](../sw-external-terms.md#csp-directive) the hosts are added to, or which hosts the configuration holds.
- The spec does not say whether [wildcards ↗](../sw-external-terms.md#csp-host-source-wildcard) are allowed in `PAYMENT_PROVIDER_HOSTS`. The no-wildcard rule is stated only for map tile hosts.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-17
- [build-csp](build-csp.md)
- [checkout-pay-route](checkout-pay-route.md)
- [content-security-policy](content-security-policy.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
