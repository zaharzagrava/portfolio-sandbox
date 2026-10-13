---
id: upstream-timeout
title: UPSTREAM_TIMEOUT
kind: term
status: draft
aliases: []
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# UPSTREAM_TIMEOUT
## Definition
`UPSTREAM_TIMEOUT` is the [errors entry](errors-entry.md) code for an [optional section](section.md) whose [upstream](upstream.md) did not answer within that section's own [section budget](section-budget.md). The section becomes `null`, and the rest of the page is served normally. It is different from [`BUDGET_EXCEEDED`](budget-exceeded.md), which means the shared [page deadline](page-deadline.md) ran out. Only the product call is retried, so a timed-out optional section is not tried again within the same request.

## Example
```json
{
  "recommendations": null,
  "errors": [
    { "section": "recommendations", "code": "UPSTREAM_TIMEOUT", "retryable": true }
  ]
}
```
(Recommendations' budget is 300 ms and the upstream answered after 500 ms. The `retryable` value is illustrative.)

## Known gaps
- The spec does not say what value `retryable` takes for `UPSTREAM_TIMEOUT`.
- The spec does not say whether an upstream timeout counts toward the circuit breaker's consecutive failures.

## Used by
<!-- used-by:start -->
- [errors-entry](errors-entry.md)
- [page-deadline](page-deadline.md)
- [section-budget](section-budget.md)
- [section](section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
