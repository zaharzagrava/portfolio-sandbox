---
id: definite-decline
title: Definite decline
kind: term
status: draft
aliases: [decline, declines]
defined_for: S13-payment-intents
rules_hash: 397cbbdcd8de
---
# Definite decline
## Definition
A definite decline is a clear "no" from the [payment provider](payment-provider.md) for a charge, such as a refused card. The provider has decided, so the outcome is known and the payment moves to [`FAILED`](payment-status.md). The decline reason is stored with the status. A decline is a normal business answer, so it never counts as a failure for the [provider operation's circuit breaker ↗](../sw-external-terms.md#circuit-breaker). The code that sorts provider answers into outcomes is [`classifyCharge`](classify-charge.md).

## Example
The processor sends the charge for an order and the provider answers that the card was declined. The payment becomes `FAILED(card_declined)`. [No ledger entry is written](ledger-posting.md) and one `payment_failed` event is emitted (S13.B-09).

## Known gaps
- The spec does not say which provider decline codes count as definite declines. It names only `card_declined`.
- The spec does not say whether a buyer can retry with another payment method after a decline, since only one payment may exist per order.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-08
- [J02](../capabilities/J02-seller-to-first-sale.md): B-09, B-19
- [S13](../capabilities/S13-payment-intents.md): R-14, B-09
- [classify-charge](classify-charge.md)
- [ledger-entry-table](ledger-entry-table.md)
- [ledger-posting](ledger-posting.md)
- [payment-provider](payment-provider.md)
- [provider-rejected](provider-rejected.md)
<!-- used-by:end -->
