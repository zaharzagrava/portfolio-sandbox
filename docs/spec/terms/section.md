---
id: section
title: Section
kind: term
status: draft
aliases: [dependent section, optional section, product section, sections]
defined_for: bff-aggregate
rules_hash: bcce1039c772
---
# Section
## Definition
A section is one named part of the combined data that the BFF returns for a single page, such as `product`, `shop` or `trending`. The [BFF ↗](../sw-external-terms.md#bff) fills each section from its own [upstream call](upstream.md), and the sections are declared in [`page/section-registry.ts`](section-registry.md). Each section succeeds, fails or is skipped without affecting the others, unless the page cannot be served without it. A section that does not apply is `null`, with no upstream call and no failure reported for it in the response. The page response gives each section its own entry in the [`Server-Timing` header ↗](../sw-external-terms.md#server-timing).

## Example
The product page includes the sections `product`, `shop`, `recommendations`, `trending`, `flags`, `chatUnread`, `discussions`, `videos`, `gallery`, `pickup`, `flashSale` and `auction`. Each one adds an entry to the timing header (durations are illustrative):
```
Server-Timing: product;dur=42.3, shop;dur=18.0
```

## Known gaps
- The spec does not say whether a section that does not apply still gets a `Server-Timing` entry.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-01, R-15, B-01
- [W02](../capabilities/W02-storefront-discovery.md): B-16
- [W07](../capabilities/W07-app-shell.md): B-13
- [bff-aggregate](../concepts/bff-aggregate.md): C-01
- [anonymous-chat-section](anonymous-chat-section.md)
- [bff-composition-library](bff-composition-library.md)
- [chat-unread](chat-unread.md)
- [conflict-error](conflict-error.md)
- [dependent-section](dependent-section.md)
- [error-code-registration](error-code-registration.md)
- [errors-entry](errors-entry.md)
- [identity-headers](identity-headers.md)
- [origin-request](origin-request.md)
- [page-aggregate](page-aggregate.md)
- [page-deadline](page-deadline.md)
- [page-upstream-sections](page-upstream-sections.md)
- [product-public-schema](product-public-schema.md)
- [public-upstream](public-upstream.md)
- [recorded-decision](recorded-decision.md)
- [request-context](request-context.md)
- [required-section](required-section.md)
- [rule-proof](rule-proof.md)
- [section-registry-entry](section-registry-entry.md)
- [section-registry](section-registry.md)
- [shop-id-param](shop-id-param.md)
- [upstream-timeout](upstream-timeout.md)
- [upstream](upstream.md)
<!-- used-by:end -->
