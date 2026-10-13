---
id: upstream
title: Upstream
kind: term
status: draft
aliases: [optional upstream, upstream call]
defined_for: bff-aggregate
rules_hash: ba386d956fac
---
# Upstream
## Definition
An upstream is a [domain API](domain-api-origin.md) that the [BFF ↗](../sw-external-terms.md#bff) calls over HTTP to fill one part of a page. The BFF never forwards the headers that carry the caller's identity, `Cookie` or an invalid [`X-Anonymous-Id`](x-anonymous-id.md) to an upstream. It sends a token only to the configured domain-API origin. Each optional upstream has its own [breaker ↗](../sw-external-terms.md#circuit-breaker), and a call to it can also be refused when too many calls to it are already waiting for a reply.

## Example
When the `product` upstream has answered, the BFF calls the `shop` section's upstream with the product's `shopId`. If that upstream has failed repeatedly, its breaker opens, the BFF stops calling it for a while, and `shop` comes back `null` with `CIRCUIT_OPEN`.

## Known gaps
- The spec does not say which domain API serves each section, and it gives no upstream endpoint names.
- Not confirmed in the code: whether the in-flight limit behind `UPSTREAM_OVERLOADED` counts calls per upstream or across all upstreams.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-02, R-08, R-12, R-16, B-01, B-11, B-13, B-20
- [bff-aggregate](../concepts/bff-aggregate.md): C-02, C-04
- [ambiguous-credentials](ambiguous-credentials.md)
- [anonymous-chat-section](anonymous-chat-section.md)
- [bff-composition-library](bff-composition-library.md)
- [chat-unread](chat-unread.md)
- [checkout-unavailable](checkout-unavailable.md)
- [domain-api-origin](domain-api-origin.md)
- [errors-entry](errors-entry.md)
- [graphql-body-size-limit](graphql-body-size-limit.md)
- [graphql-introspection](graphql-introspection.md)
- [graphql-query-limits](graphql-query-limits.md)
- [identity-headers](identity-headers.md)
- [introspection-disabled](introspection-disabled.md)
- [operation-deadline](operation-deadline.md)
- [page-upstream-sections](page-upstream-sections.md)
- [partial-response](partial-response.md)
- [payload-too-large](payload-too-large.md)
- [post-api-graphql](post-api-graphql.md)
- [problem-title](problem-title.md)
- [product-page-endpoint](product-page-endpoint.md)
- [product-public-schema](product-public-schema.md)
- [products-ids-limit](products-ids-limit.md)
- [products-ids-query](products-ids-query.md)
- [public-upstream](public-upstream.md)
- [request-id](request-id.md)
- [required-section](required-section.md)
- [resilient-http](resilient-http.md)
- [section-budget](section-budget.md)
- [section](section.md)
- [session-cookie](session-cookie.md)
- [shop-id-param](shop-id-param.md)
- [too-many-root-fields](too-many-root-fields.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
- [upstream-timeout](upstream-timeout.md)
- [upstream-unavailable-field-code](upstream-unavailable-field-code.md)
- [upstream-unavailable](upstream-unavailable.md)
- [x-anonymous-id](x-anonymous-id.md)
<!-- used-by:end -->
