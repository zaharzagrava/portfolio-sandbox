---
id: home-page
title: Home page (/)
kind: term
status: draft
aliases: [home page (`/`), homepage]
defined_for: W02-storefront-discovery
rules_hash: 12e5a0c0edaf
---
# Home page (/)
## Definition
The Home page is the storefront's landing screen at `/`, built by `HomePage` in `packages/web/app/page.tsx`. It shows a large top banner with the [search box](search-box.md), quick links to product groups, the ["Trending now" rail](recommendation-rail.md) and featured product sections further down. The [static shell](static-shell.md) arrives in the first response. The product-group links and the trending rail load afterwards, with grey placeholder shapes shown until they arrive. If trending cannot be used, the rail shows [browse-mode search](browse-mode.md) products under the same heading, with no error text.

## Example
A visitor opens `/`. The hero heading, the search box (variant `hero`) and the showcase blocks show right away, while [skeletons](skeleton.md) hold the space below them. [`GET /api/trending`](get-trending.md) then answers [`429` ↗](../sw-external-terms.md#http-429-too-many-requests). The "Trending now" rail fills with the first eight products of a browse search and shows no error message.

## Known gaps
- The spec does not say where the category shortcuts get their list of categories.
- The spec does not say whether `/` is rendered on each request or served from a cache. Only the [`trending` cache tag ↗](../sw-external-terms.md#cache-tag) is listed.

## Used by
<!-- used-by:start -->
- [browse-mode](browse-mode.md)
- [category-shortcuts](category-shortcuts.md)
- [hero-area](hero-area.md)
- [rank-badge](rank-badge.md)
- [recommendation-rail](recommendation-rail.md)
- [search-box](search-box.md)
- [showcase-blocks](showcase-blocks.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
- [streaming-section](streaming-section.md)
<!-- used-by:end -->
