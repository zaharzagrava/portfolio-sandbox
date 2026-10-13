---
id: checkout-pay-route
title: /checkout/pay/* route
kind: term
status: draft
aliases: [/checkout/pay/*]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# /checkout/pay/* route
## Definition
`/checkout/pay/*` is the group of web addresses where a buyer pays for an order. It is the only place where [`buildCsp`](build-csp.md) adds the [payment provider hosts](payment-provider-hosts.md) to the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy). Every page under this prefix gets the wider policy, and pages outside it never do.

## Example
`/checkout/pay/abc123` gets a policy that includes the hosts from [`PAYMENT_PROVIDER_HOSTS`](payment-provider-hosts.md). `/checkout` and `/cart` do not. The path `abc123` is illustrative.

## Known gaps
- The spec does not say what the pages under this prefix render, or which capability owns them. No file for them is in the facts.
- The spec does not say whether `/checkout/pay/*` is in the [private-areas list](signed-in-areas.md). That list decides [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store) and robots exclusion.

## Used by
<!-- used-by:start -->
- [payment-provider-hosts](payment-provider-hosts.md)
- [signed-in-areas](signed-in-areas.md)
<!-- used-by:end -->
