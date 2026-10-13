---
id: coordinate-rounding
title: Coordinate rounding
kind: term
status: draft
aliases: [roundcoords, rounding, rounds them]
defined_for: W02-storefront-discovery
rules_hash: 5f8783c78227
---
# Coordinate rounding
## Definition
Coordinate rounding is rule W02.R-17. The web app must round the [pickup coordinates](pickup-coordinates.md) to a fixed number of decimals before it sends them anywhere. The rule sets the precision. Rounding means the server never gets the shopper's exact position, only an area around it. That privacy reason is design intent (not stated in the spec). The spec gives privacy as the reason for keeping coordinates in memory, not for rounding. The rounding is done by [`roundCoords`](round-coords.md).

## Example
The shopper's location `50.450123, 30.523456` (illustrative) is sent as `50.450, 30.523`.

## Known gaps
- The spec does not say which rounding mode is used (half-up, [half-even ↗](../sw-external-terms.md#rounding-modes) or truncation) or how negative coordinates are handled.
- The spec does not say whether the exact unrounded value is still used locally, for example to centre the map.

## Used by
<!-- used-by:start -->
- [pickup-coordinates](pickup-coordinates.md)
- [pickup-near-me](pickup-near-me.md)
- [round-coords](round-coords.md)
<!-- used-by:end -->
