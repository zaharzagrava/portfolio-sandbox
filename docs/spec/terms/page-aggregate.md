---
id: page-aggregate
title: Page aggregate
kind: term
status: draft
aliases: [aggregate]
defined_for: bff-aggregate
rules_hash: efacf8ddf995
---
# Page aggregate
## Definition
A page aggregate is the single response the [BFF ↗](../sw-external-terms.md#bff) builds for one client screen, such as the product page. The BFF fills it by calling [domain APIs](domain-api-origin.md) over HTTP, one call per [section](section.md), within the [page deadline](page-deadline.md). If one section fails, only that section is lost. Only the [required section](required-section.md) can fail the whole page. A failed optional section comes back as `null` with an [errors entry](errors-entry.md). The response is marked private and not stored, and the `Server-Timing` header has one entry per section.

## Example
A product-page aggregate where the shop upstream timed out. The response layout and values are illustrative. The fields of the errors entry come from the spec.
```json
{ "product": { "...": "..." }, "shop": null,
  "errors": [{ "section": "shop", "code": "UPSTREAM_TIMEOUT", "retryable": true }] }
```
```
Cache-Control: private, no-store
Server-Timing: product;dur=42.3, shop;dur=250.0
```

## Known gaps
- The spec does not say anything about the cart and order page aggregates that W03 reads. It describes only the product-page aggregate.
- The spec does not say which endpoint or GraphQL query a client calls to get a page aggregate, or the exact layout of the response.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-11
- [S48](../capabilities/S48-bff.md): R-12
- [W02](../capabilities/W02-storefront-discovery.md): R-19, B-16
- [aggregate-id](aggregate-id.md)
- [bff-composition-library](bff-composition-library.md)
- [body-html](body-html.md)
- [domain-api-origin](domain-api-origin.md)
- [errors-entry](errors-entry.md)
- [get-product-gallery](get-product-gallery.md)
- [page-deadline](page-deadline.md)
- [product-page-endpoint](product-page-endpoint.md)
- [required-section](required-section.md)
- [section-registry-entry](section-registry-entry.md)
- [section-registry](section-registry.md)
- [section](section.md)
- [upstream-unavailable](upstream-unavailable.md)
<!-- used-by:end -->
