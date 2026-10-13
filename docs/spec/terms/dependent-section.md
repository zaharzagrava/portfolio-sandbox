---
id: dependent-section
title: Dependent section
kind: term
status: draft
aliases: [dependent sections]
defined_for: bff-aggregate
rules_hash: 1f2957ebcfde
---
# Dependent section
## Definition
A dependent [section](section.md) is a section that starts only after another section has answered, because it needs data from that answer. It does not get a fresh [time budget](page-deadline.md): it gets only the time left before the [page deadline](page-deadline.md). If that time runs out, it becomes `null` with [`BUDGET_EXCEEDED`](page-deadline.md).

## Example
`shop` starts only after `product` has answered, because it needs the product's `shopId`. [`trending`](section.md) also waits for `product`, because it needs the product's category.

## Known gaps
- Not confirmed in the code: whether `recommendations` also needs the product's category, or only starts after `product`. The verified notes list it together with `trending` without stating this clearly.
- The spec does not say what a dependent section does when the data it needs is missing, for example a product with no `shopId`. It also does not say whether that case counts as "does not apply" or as a failure.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-07
- [bff-aggregate](../concepts/bff-aggregate.md): C-03
- [budget-exceeded](budget-exceeded.md)
- [page-deadline](page-deadline.md)
- [product-page-endpoint](product-page-endpoint.md)
- [required-section](required-section.md)
- [section-budget](section-budget.md)
- [section-registry-entry](section-registry-entry.md)
- [section-registry](section-registry.md)
- [section](section.md)
- [shop-id-param](shop-id-param.md)
<!-- used-by:end -->
