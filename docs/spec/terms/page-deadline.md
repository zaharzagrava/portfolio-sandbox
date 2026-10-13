---
id: page-deadline
title: Page deadline
kind: term
status: draft
aliases: [deadline]
defined_for: bff-aggregate
rules_hash: b48695dba087
---
# Page deadline
## Definition
The page deadline is the total time the [BFF ↗](../sw-external-terms.md#bff) allows for putting together the combined response for one page. Every [section](section.md) must finish before it. A section that is still running when the deadline passes becomes `null` with `BUDGET_EXCEEDED`. This is separate from a section's own time limit, which gives [`UPSTREAM_TIMEOUT`](upstream.md). Dependent sections run only in the time left before the deadline.

## Example
The product page deadline is 1,000 ms. Suppose `product` answers after 700 ms (illustrative). Then `shop` has only the remaining 300 ms. If it has not answered by then, the response has `"shop": null` and the errors entry `{ "section": "shop", "code": "BUDGET_EXCEEDED", ... }`.

## Known gaps
- The spec does not say when the deadline clock starts, for example when the request arrives or when the first upstream call is made.
- The spec does not say what happens when the required section is still running at the deadline.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-07, B-10
- [bff-aggregate](../concepts/bff-aggregate.md): C-03
- [budget-exceeded](budget-exceeded.md)
- [dependent-section](dependent-section.md)
- [errors-entry](errors-entry.md)
- [operation-deadline](operation-deadline.md)
- [page-aggregate](page-aggregate.md)
- [product-page-endpoint](product-page-endpoint.md)
- [recommendations-unavailable](recommendations-unavailable.md)
- [required-section](required-section.md)
- [section-budget](section-budget.md)
- [section](section.md)
- [trending-unavailable](trending-unavailable.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
- [upstream-timeout](upstream-timeout.md)
<!-- used-by:end -->
