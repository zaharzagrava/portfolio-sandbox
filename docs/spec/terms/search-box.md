---
id: search-box
title: Search box
kind: term
status: draft
aliases: [search box (variant `hero`)]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Search box
## Definition
The search box is the text field where a visitor types a product search. It comes in three variants: `hero` on the Home page, `page` on the Search page and `navbar`. While the visitor types, it asks the [suggestions endpoint](get-suggest.md) for [query suggestions](query-suggestions.md) and shows them as an [ARIA combobox ↗](../sw-external-terms.md#aria-combobox) list. It ignores [out-of-order answers](stale-response-discard.md) by keeping only the answer for the current text. On submit, it trims the text and opens `/search` with the query in the address. It is built by `SearchBox` in `packages/web/components/search/search-box.tsx`. The suggestion requests come from [`useSuggestions`](use-suggestions.md), and [`normaliseQuery`](normalised-text.md) prepares the text on submit.

## Example
A visitor types `iph`, then `ipho`. Both suggestion requests are sent, but the answer for `iph` arrives last. The box drops that answer and lists the suggestions for `ipho` in API order. If the suggestion request fails with `429`, the list stays closed. The typed text stays as it is, and the visitor can still press Enter.

## Known gaps
- The spec does not say which suggestions endpoint path the search box calls. It may be `GET /suggest`, but the facts do not link the two.
- The spec does not say what happens when the visitor picks a suggestion. For example, it does not say whether picking one submits right away or only fills the box.
- The spec does not say whether the `navbar` variant behaves any differently from `hero` and `page`.

## Used by
<!-- used-by:start -->
- [get-suggest](get-suggest.md)
- [hero-area](hero-area.md)
- [home-page](home-page.md)
- [query-suggestions](query-suggestions.md)
- [request-throttle](request-throttle.md)
- [stale-response-discard](stale-response-discard.md)
<!-- used-by:end -->
