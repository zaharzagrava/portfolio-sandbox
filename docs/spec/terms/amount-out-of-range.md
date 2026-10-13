---
id: amount-out-of-range
title: amount_out_of_range (422)
kind: term
status: draft
aliases: [amount_out_of_range]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# amount_out_of_range (422)
## Definition
`amount_out_of_range` is the `422` error that [`POST /payments/intents`](payment-intent.md) returns when the payment amount is outside the allowed range. The amount comes from the [order copy](order-copy.md), never from the request body, so the problem is in the order's data and not in what the buyer sent. The check runs in [`checkPaymentMoney`](check-payment-money.md), which also checks that the currency is one of the supported ones. The payment is not created.

## Example
A buyer posts `{orderId, paymentMethodId}` for an order whose order copy has `amountMinor: 0` (illustrative). The answer is `422 amount_out_of_range` and no [charge command](payment-command.md) goes to the [outbox](inbox-table.md).

## Known gaps
- The spec does not say which error a currency outside `EUR`, `USD` or `GBP` returns.
- The spec does not link this rule to an [acceptance scenario](acceptance-scenario.md) ([`[proof: none]`](rule-proof.md)), so no scenario tests it.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [inbox-table](inbox-table.md)
- [order-copy](order-copy.md)
- [payment-command](payment-command.md)
<!-- used-by:end -->
