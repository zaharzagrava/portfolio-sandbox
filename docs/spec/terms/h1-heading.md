---
id: h1-heading
title: h1 heading
kind: term
status: draft
aliases: [h1]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# h1 heading
## Definition
The `h1` is the main heading of a storefront page. On the Home page (`/`) it sits in the [hero area](hero-area.md) and is part of the [static shell](static-shell.md), so it arrives in the first response. On the search page (`/search`), the `h1` comes from the address: it names the query when [`q`](autocomplete-q-parameter.md) is present and reads "All products" when `q` is absent. The server renders this `h1` together with the first search results. Putting the heading in the first response probably keeps the page structure readable before data [streams in](streaming-section.md); this is design intent (not stated in the spec).

## Example
- `/search?q=espresso` → the server returns the `h1` "Results for “espresso”", followed by the [count line](search-totals.md) and the cards.
- `/search` with no `q` → the `h1` is "All products", and the "[Match by meaning](semantic-search.md)" switch does not appear.

## Known gaps
- The spec does not say what text the `h1` in the Home page hero contains.
- The spec does not say whether the product title on `/products/[productId]` is shown as the page's `h1`.
- Not confirmed in the code: the search page `h1` strings come only from scenarios W02 AS-10 and AS-20, and no code symbol is tied to them.

## Used by
<!-- used-by:start -->
- [hero-area](hero-area.md)
- [search-totals](search-totals.md)
- [semantic-search](semantic-search.md)
- [static-shell](static-shell.md)
- [streaming-section](streaming-section.md)
<!-- used-by:end -->
