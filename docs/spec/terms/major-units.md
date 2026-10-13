---
id: major-units
title: Major units (price)
kind: term
status: draft
aliases: [major unit]
defined_for: W02-storefront-discovery
rules_hash: 2c6421bb6b6a
---
# Major units (price)
## Definition
Major units are the way a shopper writes a price, such as whole currency amounts with a decimal part. On the [search page](search-page.md), the minimum and maximum price fields accept major units. The page then converts them to [minor units](minor-units.md), using the currency's number of decimals, before building the [search filter](search-filters.md). If the minimum is above the maximum, the page refuses the input and sends no request. The conversion lives in [`parsePriceInput`](parse-price-input.md) (`packages/web/lib/search/price-input.ts`).

## Example
A shopper types `12.50` as the minimum price. In a currency with two decimals, the filter sends `1250` minor units (illustrative values).
A minimum of `100` with a maximum of `20` is refused, and no search request is sent.

## Known gaps
- The spec does not say which currencies are supported or where the page gets each currency's number of decimals.
- The spec does not say what happens when the input has more decimals than the currency allows, for example rounding or refusal.
- The spec does not say which [address parameters](search-view-url-state.md) hold the converted price filter.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-11
- [minor-units](minor-units.md)
- [parse-price-input](parse-price-input.md)
- [search-filters](search-filters.md)
- [search-page](search-page.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
