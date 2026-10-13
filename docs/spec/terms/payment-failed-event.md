---
id: payment-failed-event
title: payment_failed event
kind: term
status: draft
aliases: [payment_failed]
defined_for: S13-payment-intents
rules_hash: ed21e90ecfe7
---
# payment_failed event
## Definition
`payments.payment_failed` is the event the payments capability emits when a payment reaches [`FAILED`](payment-status.md), for example after a card decline. It tells the order system that this payment attempt will not take money. Exactly one is emitted per failed payment, and no ledger entry is written. It leaves through the [outbox](inbox-table.md) in the same transaction as the status change. An [`UNKNOWN` payment](unknown-payment-outcome.md) does not emit it, because its outcome is not yet known.

## Example
The provider declines the card. The payment becomes `FAILED(card_declined)`, with no [`LedgerEntry`](ledger-entry-table.md) row and exactly one `payments.payment_failed` event in the outbox.

## Known gaps
- The spec does not say whether [`FAILED(provider_rejected)`](provider-rejected.md) (a `400` or `401` from the provider) and a failure found by resolution also emit this event. The rules only say they make the payment `FAILED`.
- The spec does not say what the event payload contains, for example whether it includes the failure reason.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-09
- [inbox-table](inbox-table.md)
- [provider-rejected](provider-rejected.md)
- [unknown-payment-outcome](unknown-payment-outcome.md)
<!-- used-by:end -->
