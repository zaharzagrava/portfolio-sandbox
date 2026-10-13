---
id: static-shell
title: Static shell
kind: term
status: draft
aliases: [shell]
defined_for: W02-storefront-discovery
rules_hash: a9059efc8dad
---
# Static shell
## Definition
The static shell is the part of the site's front page that the first response must already contain. It is the hero with a single `h1`, the search box and the featured content blocks below them. Nothing in the shell waits on data, so a visitor can read the page and start typing a search right away. The slower parts, the quick links to browse by category and the ["Trending now" rail](recommendation-rail.md), stream in afterwards. The shell is built by `HomePage` in `packages/web/app/page.tsx`.

## Example
A visitor opens `/`. The first bytes already show the hero heading, the search box (variant `hero`) and the showcase blocks. Below them, two [same-size skeletons](skeleton.md) hold the space for the category shortcuts and "Trending now" until their content arrives.

## Known gaps
- The spec does not say whether the shell is pre-rendered at build time, cached, or rendered on each request.
- The spec does not say what text the hero `h1` contains.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-01
- [category-shortcuts](category-shortcuts.md)
- [h1-heading](h1-heading.md)
- [hero-area](hero-area.md)
- [home-page](home-page.md)
- [recommendation-rail](recommendation-rail.md)
- [showcase-blocks](showcase-blocks.md)
- [skeleton](skeleton.md)
- [streaming-section](streaming-section.md)
<!-- used-by:end -->
