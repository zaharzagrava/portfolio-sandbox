---
id: legacy-url-parameter
title: Legacy parameter
kind: term
status: draft
aliases: [legacy parameters]
defined_for: W02-storefront-discovery
rules_hash: cd58fcfca8dd
---
# Legacy parameter
## Definition
A legacy parameter is a [query parameter ↗](../sw-external-terms.md#query-string) in an older URL format that the [search page](search-page.md) no longer uses. When [`parseSearchView`](parse-search-view.md) finds one, the page cleans the address by replacing it. Unknown, repeated and [out-of-range](search-view-url-state.md) parameters get the same treatment. Afterwards the address describes the current view and nothing else. Design intent (not stated in the spec): [replacing the address ↗](../sw-external-terms.md#history-replace), instead of adding a new history entry, keeps the back button from returning to the messy URL.

## Example
A shopper opens an old bookmark: `/search?q=espresso&<old-param>=…`. The parameter name is illustrative. The page shows the "espresso" results and replaces the address with `/search?q=espresso`.

## Known gaps
- The spec does not list which parameters count as legacy.
- The spec does not say whether a legacy parameter is translated into its current equivalent or simply dropped.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-09
- [parse-search-view](parse-search-view.md)
- [search-page](search-page.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
