---
id: payments-provider-calls-total
title: payments_provider_calls_total
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# payments_provider_calls_total
## Definition
`payments_provider_calls_total` is the metric that counts calls from payments to the [payment provider](payment-provider.md). It has two [labels ↗](../sw-external-terms.md#metric-labels): [`operation`](provider-operation.md) (which provider operation was called) and [`outcome`](charge-outcome.md) (how the call ended). For a charge, `outcome` holds the classified charge outcome. For every other operation, it holds the provider's [raw answer kind](provider-raw-answer-kind.md). Labels never carry a user, order or payment ID. To trace one payment, use the logs, which carry its `paymentId` and `orderId`.

## Example
After a card decline, the charge counter goes up by one. In this example, the label value `charge` is illustrative:
```
payments_provider_calls_total{operation="charge", outcome="declined"} 1
```
To find which payment it was, search the logs for its `paymentId`.

## Known gaps
- The spec does not say the exact `operation` label values (for example, what the refund, cancel and lookup operations are called).
- The spec does not list the raw answer kinds used as `outcome` for operations other than charge.

## Used by
<!-- used-by:start -->
- [payment-provider](payment-provider.md)
- [provider-raw-answer-kind](provider-raw-answer-kind.md)
<!-- used-by:end -->
