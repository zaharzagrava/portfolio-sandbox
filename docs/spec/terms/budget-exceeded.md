---
id: budget-exceeded
title: BUDGET_EXCEEDED
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# BUDGET_EXCEEDED
## Definition
`BUDGET_EXCEEDED` is the error code for an [optional section](required-section.md) that is still unfinished when the [page deadline](page-deadline.md) passes. The section becomes `null` and the response gets one [errors entry](errors-entry.md) with this code. A [dependent section](dependent-section.md) gets only the time left on the page deadline, so it is the most likely to hit this code. GraphQL uses the same code for fields still waiting when the [operation deadline](operation-deadline.md) passes. It is not the same as `UPSTREAM_TIMEOUT`, which means a section went past its own [section budget](section-budget.md).

## Example
The page deadline is 1,000 ms. The product answers at 900 ms, so `shop` (which needs the product's `shopId`) has only the remaining time. Its upstream is still running when the deadline passes, so the page returns `"shop": null` and this errors entry:
```json
{ "section": "shop", "code": "BUDGET_EXCEEDED", "retryable": true }
```
(`retryable` value illustrative)

## Known gaps
- The spec does not say what the page returns if the required product call itself runs past the page deadline.
- The spec does not say what value `retryable` takes for `BUDGET_EXCEEDED`.

## Used by
<!-- used-by:start -->
- [dependent-section](dependent-section.md)
- [errors-entry](errors-entry.md)
- [operation-deadline](operation-deadline.md)
- [page-deadline](page-deadline.md)
- [required-section](required-section.md)
- [section-budget](section-budget.md)
<!-- used-by:end -->
