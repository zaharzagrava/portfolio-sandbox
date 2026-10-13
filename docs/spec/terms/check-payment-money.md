---
id: check-payment-money
title: checkPaymentMoney
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# checkPaymentMoney
## Definition
`checkPaymentMoney` is the domain function that checks a payment's amount and currency before the payment can exist. It checks the values taken from the [order copy](order-copy.md), never values from the request body. The amount must be a whole number of [minor units](minor-units.md) inside the allowed range; otherwise the answer is `[422 amount_out_of_range](amount-out-of-range.md)`. The currency must be one of the supported currencies. Checking the order copy rather than the buyer's input stops a buyer from choosing their own price. That reason is design intent (not stated in the spec).

## Example
A buyer sends `POST /payments/intents` with `{orderId, paymentMethodId}`. The order copy for that order holds `amountMinor: 0` (illustrative). `checkPaymentMoney` rejects it with `422 amount_out_of_range`, and no payment or [charge command](payment-command.md) is created.

## Known gaps
- The spec does not say which error code a currency other than `EUR`, `USD` or `GBP` returns.
- The spec does not link this rule to any acceptance scenario (`[proof: none]`), so no scenario is known to test the range or the currency list.
- Not confirmed in the code: whether only the [accept path](payment-intent.md) calls `checkPaymentMoney`, or the [payment processor](payment-processor.md) also calls it before it charges.

## Used by
<!-- used-by:start -->
- [minor-units](minor-units.md)
- [order-copy](order-copy.md)
- [payment-command](payment-command.md)
- [payment-intent](payment-intent.md)
- [payment-processor](payment-processor.md)
<!-- used-by:end -->
