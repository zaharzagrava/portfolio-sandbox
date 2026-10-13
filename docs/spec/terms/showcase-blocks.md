---
id: showcase-blocks
title: Showcase blocks
kind: term
status: draft
aliases: [showcase block]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Showcase blocks
## Definition
Showcase blocks are static content blocks on the [Home page](home-page.md) (`/`). They are part of the [static shell](static-shell.md), so the first response of `/` must already contain them. The spec calls them "static", which means they do not wait on trending, search or any other data source.

## Example
A visitor opens `/`. The showcase blocks are already in the first response, next to the [hero](hero-area.md) and the search box. At that moment the ["Trending now" rail](recommendation-rail.md) may still be a [skeleton](skeleton.md).

## Known gaps
- The spec does not say what the showcase blocks contain, for example promotions, categories or editorial content.
- The spec does not say where their content comes from or how it is changed. It could be hard-coded in `HomePage` or come from configuration.

## Used by
<!-- used-by:start -->
- [hero-area](hero-area.md)
- [home-page](home-page.md)
- [recommendation-rail](recommendation-rail.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
<!-- used-by:end -->
