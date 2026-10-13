---
id: settled-sale
title: Settled and unsettled sale
kind: term
status: draft
aliases: [settled sale, unsettled sale]
defined_for: S14-ledger-reconciliation
rules_hash: f65bbd47b408
---
# Settled and unsettled sale
## Definition
A sale is the [`SALE` journal](journal-kind.md) posted when a payment is captured. It moves the money into [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) and [`PLATFORM_FEES`](ledger-system-accounts.md). The sale is **unsettled** until a [`SETTLEMENT` journal](settlement-journal.md) moves that [clearing credit](clearing-credit.md) to the shops. Once the settlement has been posted, the sale is **settled**. The difference matters for refunds. Refunding an unsettled sale only reverses the three sale lines. Refunding a settled sale also [claws back](clawback.md) each shop's share. Settlement and refund of one payment are [serialized ↗](../sw-external-terms.md#serializable-isolation), so a payment that has already been refunded is never settled.

## Example
- **Unsettled:** the [`REFUND`](ledger-journal-kinds.md) reverses [`PROVIDER_CLEARING`](ledger-system-accounts.md), `MARKETPLACE_CLEARING` and `PLATFORM_FEES`, so all three net to zero for that payment.
- **Settled:** the `REFUND` also debits each [`SHOP_<uuid>`](ledger-account.md) by the share that the `SETTLEMENT` credited to it.

## Known gaps
- The spec does not say how a caller can check whether a given payment is settled. The state is shown only through which journals exist.
- The spec does not say what the [settlement consumer](settlement-consumer.md) does with an [`order.paid`](order-paid-event.md) that arrives after the refund. It only says such a payment is "never settled", not whether the event is [dead-lettered](dead-letter-topic.md) or ignored.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-06
- [clawback](clawback.md)
- [clearing-credit](clearing-credit.md)
- [dead-letter-topic](dead-letter-topic.md)
- [journal-kind](journal-kind.md)
- [ledger-account](ledger-account.md)
- [settlement-consumer](settlement-consumer.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
