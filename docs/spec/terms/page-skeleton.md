---
id: page-skeleton
title: PageSkeleton
kind: term
status: draft
aliases: [placeholder]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# PageSkeleton
## Definition
`PageSkeleton` is the web component that draws the placeholder in `<main>` while a [loading route](loading-route.md) waits for its content. The placeholder carries [`aria-busy="true"` ↗](../sw-external-terms.md#aria-busy), which tells [assistive technology ↗](../sw-external-terms.md#assistive-technology) that the area is still loading. The header and footer still render around it from the [root layout](root-layout.md). It is the code that rule W07.R-12 cites.

## Example
A visitor opens a page whose content isn't ready yet. The navbar and footer appear right away, and `<main>` holds the busy placeholder:
```html
<main id="main-content">
  <div aria-busy="true"><!-- PageSkeleton placeholder (markup illustrative) --></div>
</main>
```

## Known gaps
- Not confirmed in the code: whether the [root loading state](loading-route.md) (`packages/web/app/loading.tsx#Loading`) renders `PageSkeleton`. The facts only list the two separately.
- The spec does not say what the placeholder looks like, or whether its shape matches the page it stands in for.
- The spec does not say which routes have their own loading state besides the root one.

## Used by
<!-- used-by:start -->
- [loading-route](loading-route.md)
- [root-layout](root-layout.md)
<!-- used-by:end -->
