---
id: section-registry-entry
title: Registry entry
kind: term
status: draft
aliases: [entry]
defined_for: bff-aggregate
rules_hash: e3b0c44298fc
---
# Registry entry
## Definition
A registry entry is one [section](section.md)'s declaration inside the [section registry](section-registry.md). It names the section and marks it as [required or optional](required-section.md). It says when the section starts: at once, or after another section has answered. For a [dependent section](dependent-section.md), it also says which data the section needs from the earlier section's answer.

## Example
Three entries from `page/section-registry.ts`, described in words (this is not the file's real syntax):
- `product`: required, starts at once.
- `shop`: optional, starts after `product` answers, needs the product's `shopId`.
- `trending`: optional, starts after `product` answers, needs the product's category.

## Known gaps
- Not confirmed in the code: the exact fields and syntax of an entry, including whether an entry holds the section's endpoint function, which returns `null` when the section does not apply.
- Not confirmed in the code: whether an entry sets the section's own time limit, the one that gives `[UPSTREAM_TIMEOUT](upstream.md)` when exceeded.

## Used by
<!-- used-by:start -->
- [dependent-section](dependent-section.md)
- [page-aggregate](page-aggregate.md)
- [required-section](required-section.md)
- [section-registry](section-registry.md)
- [section](section.md)
<!-- used-by:end -->
