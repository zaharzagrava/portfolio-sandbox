---
id: currency-not-supported
title: currency_not_supported (422)
kind: term
status: draft
aliases: [currency_not_supported]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# currency_not_supported (422)
## Definition
`currency_not_supported` is the [error code](error-code.md) a product create or update gets when it names a currency other than the [platform currency](platform-currency.md). It is returned with status `422`. A request that leaves out the currency is not refused, because the platform currency is assumed.

## Example
`POST /shops/:shopId/products` with a currency that is not the platform currency gives `422 currency_not_supported` (currency and field names are illustrative):
```json
{ "title": "Mug", "price": 1200, "currency": "XYZ" }
```

## Known gaps
- The spec does not say the currency field's name or its format.
- The spec does not say the [full problem body](exact-body-members.md) for this error, for example whether it includes the supported currency.

## Used by
<!-- used-by:start -->
- [error-code](error-code.md)
- [exact-body-members](exact-body-members.md)
- [platform-currency](platform-currency.md)
<!-- used-by:end -->
