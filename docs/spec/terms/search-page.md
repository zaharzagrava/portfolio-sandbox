---
id: search-page
title: Search page (/search)
kind: term
status: draft
aliases: [/search]
defined_for: W02-storefront-discovery
rules_hash: af5e3c44bf01
---
# Search page (/search)
## Definition
`/search` is the storefront page that shows product results for a query, or for all products when there is no query. It shows results, [facets](search-facets.md), filters, sort, [cursor paging](pagination-cursor.md), the "[Match by meaning](semantic-search.md)" switch and "[Available for pickup near me](pickup-near-me.md)". The address holds the whole view, so reload, a new tab, back and forward all restore it. The page cleans unknown, legacy, repeated or out-of-range parameters by replacing the address. Without `q`, the page runs in [browse mode](browse-mode.md) under the heading "All products".

## Example
`/search?q=espresso&sort=price-asc` shows "Results for “espresso”", cheapest first, one page of 24 results (W02.R-13). With a [`nextCursor`](pagination-cursor.md), "Next page" keeps every parameter and adds `cursor`. `/search` alone shows "All products" and has no meaning-search switch.

## Known gaps
- The spec does not list the exact parameter names for facets and price in the address. Only `q`, `sort`, `cursor` and `semantic` are named.
- The spec does not give the exact rule for which parameters count as "legacy" or "out-of-range" when the page cleans the address.

## Used by
<!-- used-by:start -->
- [browse-mode](browse-mode.md)
- [legacy-url-parameter](legacy-url-parameter.md)
- [major-units](major-units.md)
- [pagination-cursor](pagination-cursor.md)
- [parse-price-input](parse-price-input.md)
- [pickup-near-me](pickup-near-me.md)
- [search-facets](search-facets.md)
- [semantic-search](semantic-search.md)
<!-- used-by:end -->
