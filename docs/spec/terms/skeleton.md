---
id: skeleton
title: Skeleton (same-size placeholder)
kind: term
status: draft
aliases: [skeleton, skeletons]
defined_for: W02-storefront-discovery
rules_hash: bca75cfc34eb
---
# Skeleton (same-size placeholder)
## Definition
A skeleton is an empty grey placeholder that shows where content will appear. On the Home page it stands in for the row of quick links to product groups and the ["Trending now" rail](recommendation-rail.md) while they stream in. Each skeleton must take up the same space as the content that replaces it. Design intent (not stated in the spec): matching sizes stop the page from jumping around when the content arrives.

## Example
The "Trending now" heading sits above a row of empty card-shaped boxes. When the trending answer (or the [browse-search fallback](browse-mode.md)) arrives, real product cards replace those boxes and the layout does not move.

## Known gaps
- The spec does not give the dimensions of the skeletons or say how "same size" is checked.
- Search results do not use skeletons. The first search view is [rendered on the server](server-rendered-search.md), and when filters change, the old results stay visible but dimmed with [`aria-busy="true"` ↗](../sw-external-terms.md#aria-busy).

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-01
- [account-slot](account-slot.md)
- [browse-mode](browse-mode.md)
- [category-shortcuts](category-shortcuts.md)
- [hero-area](hero-area.md)
- [home-page](home-page.md)
- [loading-route](loading-route.md)
- [recommendation-rail](recommendation-rail.md)
- [server-rendered-search](server-rendered-search.md)
- [showcase-blocks](showcase-blocks.md)
- [static-shell](static-shell.md)
- [streaming-section](streaming-section.md)
<!-- used-by:end -->
