---
id: section-registry
title: Section registry
kind: term
status: draft
aliases: [section-registry.ts]
defined_for: bff-aggregate
rules_hash: e3b0c44298fc
---
# Section registry
## Definition
The section registry is the file `page/section-registry.ts`, in `packages/backend/libs/composition/bff`. It declares the [sections](section.md) of the product-page [aggregate](page-aggregate.md). For each section, it says:
- whether the section is [required](required-section.md) or optional
- when the section starts: at once, or [after another section has answered](dependent-section.md)
- what data it needs from that earlier section

The registry is where you see each section's dependencies.

## Example
Three [entries](section-registry-entry.md) from the registry, described in words (this is not the file's real syntax):
- `product`: required, starts at once.
- `shop`: optional, starts after `product` answers, and needs the product's `shopId`.
- `trending`: optional, starts after `product` answers, and needs the product's category.

## Known gaps
- Not confirmed in the code: whether the registry also declares sections for the cart and order page aggregates.
- Not confirmed in the code: whether the endpoint function that returns `null` for a section that does not apply is declared in the registry or somewhere else.

## Used by
<!-- used-by:start -->
- [dependent-section](dependent-section.md)
- [page-aggregate](page-aggregate.md)
- [required-section](required-section.md)
- [section-registry-entry](section-registry-entry.md)
- [section](section.md)
<!-- used-by:end -->
