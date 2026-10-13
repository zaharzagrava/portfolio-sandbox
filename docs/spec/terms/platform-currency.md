---
id: platform-currency
title: Platform currency
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: 02d979cf34c9
---
# Platform currency
## Definition
The platform currency is the one currency in which all product prices are expressed. A product body may leave the currency out, and then the platform currency is used. Any other currency is refused with [`currency_not_supported`](currency-not-supported.md). Having one currency is a [recorded decision](recorded-decision.md) of [S05](../capabilities/S05-products.md), together with integer prices in [minor units](minor-units.md).

## Example
A create body with `{ "price": 1200 }` and no currency field is stored as 1200 minor units of the platform currency (value is illustrative).

## Known gaps
- The spec does not say which currency the platform currency is, or where it is configured.
- The spec does not say whether the platform currency can change, or what happens to existing prices if it does.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-03
- [currency-not-supported](currency-not-supported.md)
- [minor-units](minor-units.md)
- [recorded-decision](recorded-decision.md)
<!-- used-by:end -->
