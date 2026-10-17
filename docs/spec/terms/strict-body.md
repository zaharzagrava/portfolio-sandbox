---
id: strict-body
title: Strict request body
kind: term
status: draft
aliases: [strict bodies]
defined_for: S05-products
rules_hash: 0d0d8411a8ef
---
# Strict request body
## Definition
A strict request body is the rule that create and update bodies for products accept only known fields with valid values. The server refuses unknown fields, `null` values, and text, price or stock that is outside its limits. It does not drop or ignore them. Parsing happens in [`parseCreateInput`](parse-create-input.md), and [S05](../capabilities/S05-products.md) applies the same strictness to both create and update. Because of this, a client cannot slip in fields the server sets itself, such as the shop or the creator.

## Example
`PATCH /shops/:shopId/products/:productId` with this body is refused because of the unknown field and the `null` value (field names are illustrative):
```json
{ "expectedVersion": 3, "title": null, "featured": true }
```

## Known gaps
- The spec does not say which status or error code a refused body gets. [`validation_failed`](validation-failed-error.md) is only stated for a malformed product ID.
- The spec does not say the exact limits for text, price or stock in a body. It gives only the stock bounds of [`applyStockDelta`](apply-stock-delta.md).
- The spec does not say whether the error response lists every bad field or only the first one.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-02
- [domain-layer](domain-layer.md)
- [onboarding-questionnaire](onboarding-questionnaire.md)
- [parse-create-input](parse-create-input.md)
- [product-command-service](product-command-service.md)
- [unknown-body-field](unknown-body-field.md)
<!-- used-by:end -->
