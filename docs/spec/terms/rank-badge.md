---
id: rank-badge
title: Rank badge
kind: term
status: draft
aliases: [rank badges]
defined_for: W02-storefront-discovery
rules_hash: 60902448bbc7
---
# Rank badge
## Definition
A rank badge is the marker on each card in the "[Trending now](recommendation-rail.md)" rail on the [Home page](home-page.md). It shows the card's position in the [trending ranking](trending-ranking-cache.md). Cards appear in rank order, and each card links to its product page.

## Example
When `/` loads and [trending answers `200`](get-trending.md), the first card shows a badge "1" and links to `/products/<productId>`. The second card shows "2", and so on (the badge text is illustrative).

## Known gaps
- The spec does not say whether rank badges also appear when the [rail falls back](cold-start-strategy.md) to [browse-search products](browse-mode.md). It says only that the same heading is kept.
- The spec does not say how the badge looks or what text it shows.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-01
- [browse-mode](browse-mode.md)
- [cold-start-strategy](cold-start-strategy.md)
- [get-trending](get-trending.md)
- [home-page](home-page.md)
- [recommendation-rail](recommendation-rail.md)
- [trending-ranking-cache](trending-ranking-cache.md)
<!-- used-by:end -->
