---
id: build-csp
title: buildCsp
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# buildCsp
## Definition
`buildCsp` is the single pure function that builds the text of the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) for a response. The proxy calls it on every document request and puts the result in the `Content-Security-Policy` header. Each call works with a fresh [nonce ↗](../sw-external-terms.md#csp-nonce), so no two responses share one. It adds [payment provider hosts](payment-provider-hosts.md) only for `/checkout/pay/*`, and it never writes [map tile hosts](map-tile-hosts.md) as wildcards. Because one function builds the policy and one hook applies it, the policy has one source.

## Example
The proxy handles a document request for `/checkout/pay/123` (illustrative). `buildCsp` returns a policy that includes the payment provider hosts and the new nonce. A request for `/search` gets a policy with no payment provider hosts.
```
Content-Security-Policy: script-src 'self' 'nonce-r4nd0m…' …   # illustrative values
```

## Known gaps
- The spec does not say what arguments `buildCsp` takes, for example whether it gets the nonce and path from the proxy or reads them itself.
- The spec does not say which directives the policy contains, or which configured hosts (beyond payment provider and map tile hosts) it includes.
- The spec does not say whether `buildCsp` or the proxy builds the [`Reporting-Endpoints` ↗](../sw-external-terms.md#reporting-endpoints) header that goes out with the policy.

## Used by
<!-- used-by:start -->
- [map-tile-hosts](map-tile-hosts.md)
- [payment-provider-hosts](payment-provider-hosts.md)
- [web-proxy](web-proxy.md)
<!-- used-by:end -->
