---
id: not-found-state
title: NotFoundState
kind: term
status: draft
aliases: [not found state]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# NotFoundState
## Definition
`NotFoundState` is the component that shows the not-found [system state](system-state.md). It is used when a visitor requests an address the web app does not know. The response gets the not-found HTTP status, and [`<main>` ↗](../sw-external-terms.md#main-element) shows the heading "Page not found". It renders inside the [page frame](page-frame.md), so the header, navigation and footer stay usable. Design intent (not stated in the spec): the visitor can move on without pressing Back.

## Example
A request for `/no-such-page` (illustrative address) gets a [`404` ↗](../sw-external-terms.md#http-404-not-found) response. The header and footer render as usual, and `<main>` shows "Page not found" (W07.R-09, W07.B-07). The component is in `packages/web/components/layout/system-states.tsx`. The [entry point](entry-point.md) for this state is `packages/web/app/not-found.tsx#NotFound`.

## Known gaps
- Not confirmed in the code: that `NotFound` in `not-found.tsx` renders `NotFoundState`. The facts list both files but do not show how they connect.
- The spec does not say whether `NotFoundState` shows anything besides the heading, such as a search box or a link home.

## Used by
<!-- used-by:start -->
- [entry-point](entry-point.md)
- [page-frame](page-frame.md)
- [product-short-link](product-short-link.md)
- [system-state](system-state.md)
<!-- used-by:end -->
