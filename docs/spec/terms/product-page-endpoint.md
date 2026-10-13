---
id: product-page-endpoint
title: Product page endpoint
kind: term
status: draft
aliases: [/api/bff/product-page, product page]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# Product page endpoint
## Definition
The product page endpoint is the [BFF ↗](../sw-external-terms.md#bff) route that returns the [page aggregate](page-aggregate.md) for one product in a single response. It calls the [product upstream](upstream.md) first, then starts the [optional and dependent sections](dependent-section.md), all within the [page deadline](page-deadline.md). Only the product section is required: an optional section that fails or runs out of time becomes a [null section](null-section.md) with an errors entry. Every response is marked private and not to be stored, and its `Server-Timing` header has one entry per section. The route has its own rate limit per principal.

## Example
An anonymous visitor opens a visible product, and every upstream is healthy:
```
GET /api/bff/product-page/3f1c2a9e-0000-4000-8000-000000000000    (illustrative UUID)
200
Cache-Control: private, no-store
Server-Timing: product;dur=42.3, shop;dur=18.0, ...                (illustrative durations)
```

## Known gaps
- The spec does not say how the response body is laid out (the top-level member names or where each section sits). It only names the `errors` entries and their `{section, code, retryable}` shape.
- The spec does not say which principal the rate limit counts for an anonymous visitor. It could be the `X-Anonymous-Id` header, the client address or something else.

## Used by
<!-- used-by:start -->
- [dependent-section](dependent-section.md)
- [not-found-error](not-found-error.md)
- [null-section](null-section.md)
- [page-aggregate](page-aggregate.md)
- [page-deadline](page-deadline.md)
- [retryable](retryable.md)
- [upstream](upstream.md)
<!-- used-by:end -->
