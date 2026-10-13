---
id: minor-units
title: Minor units (price)
kind: term
status: draft
aliases: [minor unit]
defined_for: S05-products
rules_hash: b4a4da20be42
---
# Minor units (price)
## Definition
In [S05](../capabilities/S05-products.md), a price is stored and sent as a whole number in the currency's smallest unit, such as cents, not as a decimal amount. Floats are never used for money. This is a [recorded decision](recorded-decision.md) of the [product service](../capabilities/S05-products.md). Prices that [other domains](orders-domain.md) read come from the database in this same integer form.

## Example
A product priced at 19.99 in a currency with two decimal places is sent as `1999` (illustrative values):
```json
{ "price": 1999 }
```

## Known gaps
- The spec does not say the price field's name or its allowed range.
- The spec does not say how many decimal places the [platform currency](platform-currency.md) has, so the conversion factor is not stated.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-03
- [S10](../capabilities/S10-cart-checkout.md): R-15, B-05, B-16
- [W02](../capabilities/W02-storefront-discovery.md): R-11
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [check-payment-money](check-payment-money.md)
- [discount-tie-break](discount-tie-break.md)
- [expected-total-minor](expected-total-minor.md)
- [line-position](line-position.md)
- [major-units](major-units.md)
- [order-total](order-total.md)
- [orders-domain](orders-domain.md)
- [parse-price-input](parse-price-input.md)
- [platform-currency](platform-currency.md)
- [recorded-decision](recorded-decision.md)
- [seller-discount](seller-discount.md)
- [shop-subtotal](shop-subtotal.md)
<!-- used-by:end -->
