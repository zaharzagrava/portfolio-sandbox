---
id: round-coords
title: roundCoords
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# roundCoords
## Definition
`roundCoords` is the web helper in `packages/web/lib/pickup/coords.ts` that applies [coordinate rounding](coordinate-rounding.md) (W02.R-17). It takes the shopper's [pickup coordinates](pickup-coordinates.md) and returns them at the precision the rule sets. [Pickup near me](pickup-near-me.md) calls it before it sends a location from the browser. It belongs to the web app, not the backend.

## Example
Input and output (illustrative values; the exact signature is not in the facts):
```
in:  { 50.450123, 30.523456 }
out: { 50.450,    30.523    }
```

## Known gaps
- The spec does not say the function's signature or return type, for example an object or a tuple, or numbers or strings.
- The spec does not say which [rounding mode ↗](../sw-external-terms.md#rounding-modes) it uses.
- Not confirmed in the code: the helper tests cover "coordinates", but the facts do not say they test `roundCoords` itself.

## Used by
<!-- used-by:start -->
- [coordinate-rounding](coordinate-rounding.md)
- [pickup-coordinates](pickup-coordinates.md)
- [pickup-near-me](pickup-near-me.md)
<!-- used-by:end -->
