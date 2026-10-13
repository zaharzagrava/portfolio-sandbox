---
id: streaming-section
title: Streaming in behind skeletons
kind: term
status: draft
aliases: [stream in behind same-size skeletons, streams]
defined_for: W02-storefront-discovery
rules_hash: bca75cfc34eb
---
# Streaming in behind skeletons
## Definition
Streaming in behind [skeletons](skeleton.md) is how the Home page delivers its slower parts. The server sends the [static shell](static-shell.md) first. It sends the [category shortcuts](category-shortcuts.md) and the ["Trending now" rail](recommendation-rail.md) later, in the same response, as each one becomes ready. Until a part arrives, a same-size skeleton holds its place. A slow trending lookup therefore never delays the rest of the page. That last point is design intent (not stated in the spec).

## Example
On `/`, the hero and the search box appear at once. A moment later the "Trending now" rail replaces its skeleton with up to eight ranked cards, each linking to `/products/<productId>`.

## Known gaps
- The spec does not say which rendering mechanism does the streaming (for example, which framework feature is used).
- The spec does not say what the category shortcuts show if their data fails. Only the trending rail has a defined fallback, which is a [browse search](browse-mode.md).

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-01
- [browse-mode](browse-mode.md)
- [category-shortcuts](category-shortcuts.md)
- [h1-heading](h1-heading.md)
- [home-page](home-page.md)
- [recommendation-rail](recommendation-rail.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
<!-- used-by:end -->
