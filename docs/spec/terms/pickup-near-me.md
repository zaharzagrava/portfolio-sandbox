---
id: pickup-near-me
title: Pickup near me
kind: term
status: draft
aliases: [available for pickup near me, pickup near me tab]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Pickup near me
## Definition
Pickup near me is the storefront feature that lists pickup points near the shopper. On the storefront's search results it is the "Available for pickup near me" option. On the product page it is the "Pickup near me" tab, next to Details, Ask about this product and Discussions. Both use the shopper's location, which stays in memory and is made less precise before it is sent (W02.R-17). The feature has a map, and its tile source is set by [`NEXT_PUBLIC_MAP_TILE_URL`](map-tile-hosts.md).

## Example
A shopper on `/search?q=espresso` turns on "Available for pickup near me". The web app rounds their location and sends it with the search. On `/products/[productId]`, the "Pickup near me" tab shows the pickup points for that product.

## Known gaps
- The spec does not say how the location is obtained (for example, the browser's location prompt) or which endpoint receives it.
- The spec does not say whether the "Available for pickup near me" switch is stored in [the address](search-view-url-state.md). The coordinates cannot be, because they stay in memory.
- Not confirmed in the code: the scenarios AS-28 to AS-31, AS-41 and AS-42 have only helper tests (formatting, coordinates, location messages). No test covers the full flow or the map.

## Used by
<!-- used-by:start -->
- [coordinate-rounding](coordinate-rounding.md)
- [pickup-coordinates](pickup-coordinates.md)
- [product-discussions](product-discussions.md)
- [product-page-tabs](product-page-tabs.md)
- [round-coords](round-coords.md)
- [search-page](search-page.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
