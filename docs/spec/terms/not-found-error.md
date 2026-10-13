---
id: not-found-error
title: not_found (404)
kind: term
status: draft
aliases: [not_found]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# not_found (404)
## Definition
`not_found` is the error the [product page endpoint](product-page-endpoint.md) returns when the product does not exist or is [not visible](search-visibility.md). The product is the only [required section](required-section.md), so this error fails the whole page. Optional sections never cause it: when one fails, it becomes `null` and gets an [errors entry](errors-entry.md). The page returns the same answer whether the product is unknown or invisible. Design intent (not stated in the spec): sharing one answer means a caller cannot tell a hidden product from a missing one.

## Example
`GET /api/bff/product-page/3f1c2a9e-0000-4000-8000-000000000000` (illustrative UUID) for a product that is unknown or invisible gives `404 not_found`. No sections are returned.

## Known gaps
- The spec does not say what makes a product "invisible", or which upstream answer the [BFF ↗](../sw-external-terms.md#bff) reads as invisible.
- The spec does not say which members the `not_found` problem body contains.

## Used by
<!-- used-by:start -->
- [errors-entry](errors-entry.md)
- [product-page-endpoint](product-page-endpoint.md)
- [required-section](required-section.md)
- [search-visibility](search-visibility.md)
<!-- used-by:end -->
