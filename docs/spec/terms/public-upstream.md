---
id: public-upstream
title: Public upstream
kind: term
status: draft
aliases: [public upstreams]
defined_for: S48-bff
rules_hash: a85742c5c55f
---
# Public upstream
## Definition
A public [upstream](upstream.md) is an upstream that the [BFF ↗](../sw-external-terms.md#bff) calls without credentials, so every visitor gets the same answer. Only public upstream calls are [single-flighted ↗](../sw-external-terms.md#single-flight). When many visitors ask for the same data at the same time, they share one upstream call. The [shared cache ↗](../sw-external-terms.md#shared-cache) may keep a [public section](section.md) only as long as the upstream's [`s-maxage` ↗](../sw-external-terms.md#cache-control) allows. Calls that carry a [bearer token ↗](../sw-external-terms.md#authorization-bearer), such as flags and chat for a signed-in session, are not public.

## Example
50 visitors request `GET /api/bff/product-page/:productId` for the same product within 50 ms. Each public upstream, for example the one behind the `product` section, receives only one call.

## Known gaps
- The spec does not say which of the page's sections use public upstreams. Only flags and chat are named as carrying a token.
- The spec does not say how a public upstream that answers `private` or `no-store` is handled. Known gaps lists these cases as only partly tested.
- The spec does not give a reason for single-flighting only public calls. The likely reason is design intent (not stated in the spec): a credentialed answer is personal and must not be shared between principals.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-02
- [S48](../capabilities/S48-bff.md): B-05
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
