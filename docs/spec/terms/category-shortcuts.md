---
id: category-shortcuts
title: Category shortcuts
kind: term
status: draft
aliases: [category shortcut]
defined_for: W02-storefront-discovery
rules_hash: bca75cfc34eb
---
# Category shortcuts
## Definition
Category shortcuts are quick links on the [Home page](home-page.md) that take a shopper into a product category. They appear in the top banner section of the page, together with the search box. They are not part of the [static shell](static-shell.md): they [stream in behind a same-size skeleton](skeleton.md).

## Example
A visitor opens `/`. A row of category shortcuts appears under the search box once their data has streamed in. Clicking one starts browsing that category.

## Known gaps
- The spec does not say where the shortcuts get their list of categories, or in what order they appear.
- The spec does not say which URL a shortcut opens (for example, `/search` with a [category facet](search-facets.md)).
- The spec does not say what is shown if the category data fails to load.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-01
- [hero-area](hero-area.md)
- [home-page](home-page.md)
- [search-facets](search-facets.md)
- [skeleton](skeleton.md)
- [static-shell](static-shell.md)
- [streaming-section](streaming-section.md)
<!-- used-by:end -->
