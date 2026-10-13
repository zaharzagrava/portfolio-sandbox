---
id: get-product-recommendations
title: GET /api/products/:productId/recommendations
kind: term
status: draft
aliases: [/api/products/:productid/recommendations]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# GET /api/products/:productId/recommendations
## Definition
This is the public endpoint that serves the [bought-together](bought-together.md) [recommendation rail](recommendation-rail.md) for one product. It is anonymous and returns the same body to every caller, so a CDN can cache it. It reads the product's stored [neighbour list](neighbour-list.md). If there are too few [direct neighbours](direct-neighbour.md), it adds candidates found through a [2-hop lookup](two-hop-lookup.md). It filters out hidden products on every origin request. If a store or lookup fails, it answers [`recommendations_unavailable`](recommendations-unavailable.md) and never sends an unfiltered list.

## Example
```
GET /api/products/M/recommendations?type=bought-together
→ 200, [Cache-Control: public, max-age=60, s-maxage=300 ↗](../sw-external-terms.md#cache-control)
  items: C (score 0.2067, hops 1), then P (score 0.1794, hops 1)
```
A product with no stored list, or with only hidden neighbours, gets `200` with `items: []`.

## Known gaps
- The spec does not say the full JSON shape of an item. It names `productId`, the score and `hops`, but gives no exact member names for the score or for other fields.
- The spec does not say whether `type` is required or defaults to `bought-together` when left out. Behavior S34.B-02 shows requests that seem to omit it.
- Not confirmed in the code: the visibility filter (S34.R-06) and replacing hidden neighbours without padding (S34.R-07) have no code link.

## Used by
<!-- used-by:start -->
- [bought-together](bought-together.md)
- [direct-neighbour](direct-neighbour.md)
- [neighbour-list](neighbour-list.md)
- [recommendation-rail](recommendation-rail.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
