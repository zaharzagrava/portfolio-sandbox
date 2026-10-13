---
id: loading-route
title: Loading route
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 1fce27274438
---
# Loading route
## Definition
A loading route is a page whose content is not ready yet, so the app shows a temporary state in its place. The header and footer still render as normal. Inside `<main>` the visitor sees a placeholder marked [`aria-busy="true"` ↗](../sw-external-terms.md#aria-busy), so [assistive technology ↗](../sw-external-terms.md#assistive-technology) knows the area is still filling in. The [root of the app](root-layout.md) has its own loading state, and the placeholder is drawn by [`PageSkeleton`](page-skeleton.md).

## Example
A visitor opens a page whose data is still on its way. The navbar and footer show at once, and `<main>` holds a [skeleton](skeleton.md) like this:
```html
<main id="main-content" aria-busy="true"><!-- PageSkeleton placeholder --></main>
```

## Known gaps
- The spec does not say which routes have their own loading state. Only the root one is listed (`packages/web/app/loading.tsx#Loading`).
- The spec does not say when `aria-busy` returns to false, or how the real content replaces the placeholder.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-12
- [page-skeleton](page-skeleton.md)
- [root-layout](root-layout.md)
- [skeleton](skeleton.md)
- [system-state](system-state.md)
<!-- used-by:end -->
