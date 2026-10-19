---
id: minor-units
title: Minor units (price)
kind: term
status: draft
aliases: [minor unit]
defined_for: S05-products
rules_hash: 7e6757ecda9e
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
- [S10](../capabilities/S10-cart-checkout.md): R-15
- [S14](../capabilities/S14-ledger-reconciliation.md): R-01, R-11
- [S28](../capabilities/S28-notifications.md): R-09, R-56
- [W02](../capabilities/W02-storefront-discovery.md): R-11
- [aggregate-rows](aggregate-rows.md)
- [available-minor](available-minor.md)
- [balance-overflow](balance-overflow.md)
- [balanced-journal](balanced-journal.md)
- [bid-increment](bid-increment.md)
- [catalog-product-updated-event](catalog-product-updated-event.md)
- [catalog-template](catalog-template.md)
- [check-payment-money](check-payment-money.md)
- [classify-line](classify-line.md)
- [discount-tie-break](discount-tie-break.md)
- [expected-total-minor](expected-total-minor.md)
- [guarded-account](guarded-account.md)
- [journal-conflict](journal-conflict.md)
- [journal-posted-event](journal-posted-event.md)
- [ledger-invariants](ledger-invariants.md)
- [ledger-journal](ledger-journal.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [ledger](ledger.md)
- [line-position](line-position.md)
- [line-total-minor](line-total-minor.md)
- [locale](locale.md)
- [major-units](major-units.md)
- [notification-rendering](notification-rendering.md)
- [order-total](order-total.md)
- [orders-domain](orders-domain.md)
- [parse-price-input](parse-price-input.md)
- [payment-capture](payment-capture.md)
- [payout-journal](payout-journal.md)
- [platform-currency](platform-currency.md)
- [platform-fee](platform-fee.md)
- [proxy-bidding](proxy-bidding.md)
- [reconciliation-issue](reconciliation-issue.md)
- [recorded-decision](recorded-decision.md)
- [render-failure](render-failure.md)
- [seller-discount](seller-discount.md)
- [settlement-journal](settlement-journal.md)
- [shop-share](shop-share.md)
- [shop-subtotal](shop-subtotal.md)
- [unit-price-minor](unit-price-minor.md)
<!-- used-by:end -->
