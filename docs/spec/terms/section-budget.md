---
id: section-budget
title: Section budget
kind: term
status: draft
aliases: [budget]
defined_for: S48-bff
rules_hash: 1a008fd0d04f
---
# Section budget
## Definition
A section budget is the time limit for one section's [upstream call](upstream.md) on the product page. If the upstream has not answered within it, the [BFF ↗](../sw-external-terms.md#bff) stops waiting. The section becomes `null` with [`UPSTREAM_TIMEOUT`](upstream-timeout.md), and the other sections are unaffected. The section budget is separate from the [page deadline](page-deadline.md). A [dependent section](dependent-section.md) is also capped by the time left on the page deadline, and running out of that gives [`BUDGET_EXCEEDED`](budget-exceeded.md) instead. Budgets come from the BFF configuration, and a missing or invalid value stops the process.

## Example
The `recommendations` budget is 300 ms. Its upstream answers after 500 ms, so the page returns `"recommendations": null` with an [errors entry](errors-entry.md) `{ "section": "recommendations", "code": "UPSTREAM_TIMEOUT", ... }`, and every other section is still filled.

## Known gaps
- The spec does not say the budget value for any section except `recommendations`.
- The spec does not say whether the required product call has its own section budget.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-03
- [budget-exceeded](budget-exceeded.md)
- [dependent-section](dependent-section.md)
- [errors-entry](errors-entry.md)
- [page-deadline](page-deadline.md)
- [production-configuration](production-configuration.md)
- [upstream-timeout](upstream-timeout.md)
- [upstream](upstream.md)
<!-- used-by:end -->
