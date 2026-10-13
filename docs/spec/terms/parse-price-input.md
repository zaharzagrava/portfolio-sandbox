---
id: parse-price-input
title: parsePriceInput
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# parsePriceInput
## Definition
`parsePriceInput` is the function on the [search page](search-page.md) that reads what a shopper types in the minimum and maximum price fields. It takes those values in [major units](major-units.md). It converts them to [minor units](minor-units.md) using the currency's number of decimals, and the [search filter](search-filters.md) uses the converted values. Rule W02.R-11 links to this function. Under that rule, a minimum above the maximum is refused before any search request is sent. The function is in `packages/web/lib/search/price-input.ts`.

## Example
A shopper types `12.50` as the minimum price in a currency with two decimals. The filter then uses `1250` minor units (illustrative values).
If the shopper types a minimum of `100` and a maximum of `20`, the page refuses the input and sends no search request (illustrative values).

## Known gaps
- The spec does not say where the function gets each currency's number of decimals, or which currencies it supports.
- The spec does not say what happens when the input has more decimals than the currency allows, or when it is not a number (for example, whether it is rounded or refused).
- Not confirmed in the code: whether the minimum-above-maximum check is inside `parsePriceInput` or in the code that calls it. The rule only links to this function.

## Used by
<!-- used-by:start -->
- [major-units](major-units.md)
- [minor-units](minor-units.md)
- [search-filters](search-filters.md)
- [search-page](search-page.md)
<!-- used-by:end -->
