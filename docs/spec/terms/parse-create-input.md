---
id: parse-create-input
title: parseCreateInput
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# parseCreateInput
## Definition
`parseCreateInput` is the domain function that checks and parses the body of a product create request. It enforces the [strict-body rule](strict-body.md): unknown fields, `null` values, and text, price or stock outside their limits are refused, not silently dropped. It lives in the [catalog domain layer](catalog-domain-layer.md), so the check runs before any product is built. The shop and creator are never read from the body; the server sets them from the route and [the principal](principal.md).

## Example
`POST /shops/:shopId/products` with this body is refused, because `shopId` is not an accepted body field and `description` is `null` (field names and values are illustrative):
```json
{ "title": "Mug", "price": 1299, "description": null, "shopId": "other-shop" }
```

## Known gaps
- Not confirmed in the code: whether [`PATCH` ↗](../sw-external-terms.md#http-patch) bodies go through `parseCreateInput` or through a separate update parser. The rule covers both, but only `parseCreateInput` is cited.
- The spec does not say which status or error code a refused body gets. [`validation_failed`](validation-failed-error.md) is only stated for a malformed product ID.
- The spec does not say the exact text, price or stock limits that `parseCreateInput` checks.

## Used by
<!-- used-by:start -->
- [catalog-domain-layer](catalog-domain-layer.md)
- [principal](principal.md)
- [strict-body](strict-body.md)
<!-- used-by:end -->
