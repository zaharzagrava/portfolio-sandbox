---
id: pickup-coordinates
title: Pickup coordinates
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: 39d0087db165
---
# Pickup coordinates
## Definition
Pickup coordinates are the shopper's location, used by "[Available for pickup near me](pickup-near-me.md)" on the search page and the "Pickup near me" tab on the product page. The web app keeps them only in memory and never stores them anywhere else. Before sending them, it cuts them to a fixed, coarser precision, which the spec says protects the shopper's location privacy. This step lives in [`roundCoords`](round-coords.md) (`packages/web/lib/pickup/coords.ts`).

## Example
A location of `50.450123, 30.523456` is sent as `50.450, 30.523` (illustrative coordinates).

## Known gaps
- The spec does not say how the coordinates are obtained, for example from the browser's location prompt, or which endpoint receives them.
- The spec does not say how long they stay in memory, for example only for one page or across navigation.
- Not confirmed by tests: the Pickup near me scenarios have only helper tests (formatting, coordinates, location messages). No test covers the full flow or the map.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-17
- [coordinate-rounding](coordinate-rounding.md)
- [pickup-near-me](pickup-near-me.md)
- [round-coords](round-coords.md)
- [search-view-url-state](search-view-url-state.md)
<!-- used-by:end -->
