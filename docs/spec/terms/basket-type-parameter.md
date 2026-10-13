---
id: basket-type-parameter
title: type (bought-together parameter)
kind: term
status: draft
aliases: [also-viewed, type]
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# type (bought-together parameter)
## Definition
`type` is a query parameter of [`GET /api/products/:productId/recommendations`](get-product-recommendations.md) that selects the kind of [recommendation rail](recommendation-rail.md). The only accepted value is [`bought-together`](bought-together.md). Any other value is rejected with [`validation_failed`](validation-failed-error.md), and the error names the field `type`. Accepting a single value now leaves room for other rail kinds later without changing the URL: design intent (not stated in the spec).

## Example
```
GET /api/products/M/recommendations?type=also-viewed
→ 400 validation_failed, errors: [{field: "type"}]
```

## Known gaps
- The spec does not say whether `type` is optional. [Behavior S34.B-02](behavior.md) shows requests without it, which suggests that `bought-together` is the default when `type` is left out.

## Used by
<!-- used-by:start -->
- [behavior](behavior.md)
- [recommendation-rail](recommendation-rail.md)
<!-- used-by:end -->
