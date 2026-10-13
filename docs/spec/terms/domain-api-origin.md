---
id: domain-api-origin
title: Domain-API origin
kind: term
status: draft
aliases: [configured domain-api origin]
defined_for: bff-aggregate
rules_hash: 37c0ef244a31
---
# Domain-API origin
## Definition
The domain-API origin is the configured origin of the domain APIs that the BFF calls over HTTP to build page aggregates. It is the only place the BFF may send a user's token. The rule stops a token from leaking to any other host, including a host taken from a URL or redirect. That reason is design intent (not stated in the spec).

## Example
Say the BFF is configured with `https://api.internal.example` (illustrative). It may send the token on calls to that origin for the product section. It must never attach the token to a request to any other host.

## Known gaps
- The spec does not say the name of the configuration setting, or whether more than one origin can be configured.
- The spec does not say how origins are compared (scheme, host and port), or what happens when a call targets a different origin.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-13
- [W01](../capabilities/W01-auth-account.md): R-02
- [bff-aggregate](../concepts/bff-aggregate.md): C-05
- [bff-forwarder](bff-forwarder.md)
- [graphql-query-limits](graphql-query-limits.md)
- [identity-headers](identity-headers.md)
- [page-aggregate](page-aggregate.md)
- [page-upstream-sections](page-upstream-sections.md)
- [production-configuration](production-configuration.md)
- [route-guard](route-guard.md)
- [upstream](upstream.md)
<!-- used-by:end -->
