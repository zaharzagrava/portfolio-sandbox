---
id: server-rendered-search
title: Server-rendered search page
kind: term
status: draft
aliases: [server returns the results]
defined_for: W02-storefront-discovery
rules_hash: a450e0caf745
---
# Server-rendered search page
## Definition
The server builds the first view of the search page, not the browser. The first response already contains the heading, the count line and the result cards. Shoppers therefore see results without a [loading skeleton](skeleton.md). This was a [recorded decision](recorded-decision.md) for the [search capability](capability.md). The server reads the [search view from the address](search-view-url-state.md), so a reloaded or shared link renders the same results.

## Example
Opening `/search?q=espresso` returns HTML that already contains the `h1` "Results for “espresso”", the count line and the product cards. No loading state comes first.

## Known gaps
- The spec does not say whether later changes (filters, sort, next page) are rendered on the server or fetched by the browser. W02.B-13 only says the [previous results stay dimmed](stale-response-discard.md) until the new ones arrive.
- The spec does not say what the server returns on the first render if search fails. W02.R-16 only requires [exactly one alert](form-alert.md) and no stale results.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-06
- [capability](capability.md)
- [form-alert](form-alert.md)
- [recorded-decision](recorded-decision.md)
- [search-view-url-state](search-view-url-state.md)
- [skeleton](skeleton.md)
- [stale-response-discard](stale-response-discard.md)
<!-- used-by:end -->
