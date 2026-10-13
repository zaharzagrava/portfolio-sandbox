---
id: provider-raw-answer-kind
title: Provider raw answer kind
kind: term
status: draft
aliases: [provider's raw answer kind, raw answer kinds]
defined_for: S13-payment-intents
rules_hash: 04eca7cbfe37
---
# Provider raw answer kind
## Definition
A provider raw answer kind is the kind of answer the payment provider gave to a [provider operation](provider-operation.md), with no further processing. `payments_provider_calls_total` uses it as the `outcome` label for every provider operation except a charge. A charge goes through [`classifyCharge`](classify-charge.md) instead, and its label holds the [classified charge outcome](charge-outcome.md). So for a refund, cancel or lookup, the label shows what the provider answered, not what that answer means for the payment. Like every label on this metric, it never carries a user, order or payment ID.

## Example
A refund requested through [`orders-refund-requested`](orders-refund-requested-event.md) makes one provider refund call, with the reference `refund:<paymentId>`. The counter goes up under the provider's own answer kind:
```
payments_provider_calls_total{operation="refund", outcome="<provider's raw answer kind>"} 1
```
The `operation` value `refund` is illustrative. To find the payment, search the logs for its `paymentId` and `orderId`.

## Known gaps
- The spec does not say which raw answer kinds exist, so you cannot know the possible `outcome` values for refund, cancel or lookup in advance.
- The spec does not say how a non-charge call is counted when it is never sent (for example, when an [open breaker ↗](../sw-external-terms.md#circuit-breaker) refuses it) or when it times out. For a charge, those cases are `not_sent` and `ambiguous`.
- Not confirmed in the code: rule S13.R-27 has no `[code]` link, so where the raw answer kind is set as the label has not been checked.

## Used by
<!-- used-by:start -->
- [charge-outcome](charge-outcome.md)
- [payments-provider-calls-total](payments-provider-calls-total.md)
- [provider-operation](provider-operation.md)
<!-- used-by:end -->
