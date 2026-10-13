---
id: required-section
title: Required section
kind: term
status: draft
aliases: [optional section, required]
defined_for: bff-aggregate
rules_hash: ff5d3c7aec01
---
# Required section
## Definition
A required section is a section whose failure fails the whole page response, so nothing is served. On the product page, only the product section is required. Every other section is optional: when it fails, it becomes `null` with an [errors entry](errors-entry.md) and the page is still served. The required section starts at once, and sections that need its result wait for its answer.

## Example
If the [`product` upstream](upstream.md) fails, the product page request fails. If only the `discussions` upstream fails, the page is still served: `discussions` is `null`, and the response carries one errors entry for `discussions`.

## Known gaps
- The spec does not say what the client receives when the required section fails: which HTTP status, which error code, or whether any optional section data is still returned.
- The spec does not say whether the required section is also cut off by the [page deadline](page-deadline.md), or what happens if it is.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-03, B-04
- [W02](../capabilities/W02-storefront-discovery.md): R-19
- [bff-aggregate](../concepts/bff-aggregate.md): C-02
- [budget-exceeded](budget-exceeded.md)
- [dependent-section](dependent-section.md)
- [errors-entry](errors-entry.md)
- [not-found-error](not-found-error.md)
- [page-aggregate](page-aggregate.md)
- [page-deadline](page-deadline.md)
- [product-public-schema](product-public-schema.md)
- [retryable](retryable.md)
- [section-registry-entry](section-registry-entry.md)
- [section-registry](section-registry.md)
- [section](section.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
- [upstream](upstream.md)
<!-- used-by:end -->
