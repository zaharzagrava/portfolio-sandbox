---
id: product-public-schema
title: productPublicSchema
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# productPublicSchema
## Definition
`productPublicSchema` is the schema that the [product upstream](upstream.md)'s response body must match before the [BFF ↗](../sw-external-terms.md#bff) uses it. If the body does not match, the [whole page fails](required-section.md) with [`upstream_invalid`](upstream-invalid.md), and the problem [`detail`](problem-detail.md) is generic. Design intent (not stated in the spec): a broken upstream body should not reach clients, and validation details should not leak.

## Example
The product upstream answers 200 with a body that fails `productPublicSchema` (for example, a required field is missing: illustrative). The client gets `502 upstream_invalid` with a generic `detail` and no [sections](section.md).

## Known gaps
- The spec does not list the fields that `productPublicSchema` requires.
- Not confirmed in the code: the file where `productPublicSchema` is defined, and whether the same schema is used for GraphQL product fields.

## Used by
<!-- used-by:start -->
- [required-section](required-section.md)
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
