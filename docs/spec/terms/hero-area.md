---
id: hero-area
title: Hero area
kind: term
status: draft
aliases: [hero]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Hero area
## Definition
The hero area is the top block of the [Home page (`/`)](home-page.md). It holds the page's main [`h1`](h1-heading.md) heading and the [search box](search-box.md) in its `hero` variant. It belongs to the [static shell](static-shell.md), so it arrives in the first response of `/` and does not wait for any data. Other Home page content, such as the "Trending now" rail, streams in later behind [skeletons](skeleton.md).

## Example
A visitor opens `/`. The first response already includes the hero area, with its `h1` and the search box (`<SearchBox>` with variant `hero`). When the visitor types `iph`, the box requests suggestions before the trending rail has finished loading.

## Known gaps
- The spec does not say what text the hero's `h1` contains.
- The spec does not say whether the [category shortcuts](category-shortcuts.md) sit inside the hero area or below it. The entry point lists them next to the hero, but R-01 keeps them out of the static shell.
- The spec does not say whether the `hero` variant of the search box behaves differently from the `page` and `navbar` variants, apart from where it appears.

## Used by
<!-- used-by:start -->
- [category-shortcuts](category-shortcuts.md)
- [h1-heading](h1-heading.md)
- [home-page](home-page.md)
- [search-box](search-box.md)
- [showcase-blocks](showcase-blocks.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
<!-- used-by:end -->
