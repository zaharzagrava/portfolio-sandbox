---
id: origin-request
title: Origin request
kind: term
status: draft
aliases: [origin]
defined_for: S34-recommendations
rules_hash: 407692ee9597
---
# Origin request
## Definition
An origin request is a request that reaches the backend because the CDN could not answer it from its own cached copy. Every origin request checks [visibility](search-visibility.md) again, against the product and the shop. Because of that, a hidden product can only appear for as long as the CDN copy lives. Error answers carry [`no-store` ↗](../sw-external-terms.md#cache-control-no-store), so they are not cached and every retry is an origin request.

## Example
A buyer requests `/api/products/M/recommendations` after the CDN copy has expired ([`s-maxage=300` ↗](../sw-external-terms.md#cache-control)). The request reaches the origin, and the origin re-checks product `C` and its shop before listing it.

## Known gaps
- The spec does not say how the browser cache (`max-age=60`) adds to the CDN staleness window. The [Decisions section](section.md) mentions only the CDN copy.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-06
- [S35](../capabilities/S35-trending.md): R-11
- [catalog-category](catalog-category.md)
- [get-trending](get-trending.md)
- [recommendation-rail](recommendation-rail.md)
- [search-visibility](search-visibility.md)
- [section](section.md)
<!-- used-by:end -->
