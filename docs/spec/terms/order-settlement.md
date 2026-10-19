---
id: order-settlement
title: Order settlement
kind: term
status: draft
aliases: [settled, settlement]
defined_for: S14-ledger-reconciliation
rules_hash: 1c6c3bd0702e
---
# Order settlement
## Definition
Order settlement moves a paid order's money from [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) into the sellers' [`SHOP_<uuid>`](ledger-account.md) accounts. [The settlement consumer](settlement-consumer.md) does this when it receives [`order.paid`](order-paid-event.md), by posting one [`SETTLEMENT` journal](settlement-journal.md). The journal [debits the clearing credit ↗](../sw-external-terms.md#double-entry-bookkeeping) from the sale and credits each shop its share. Only the ledger may post `SETTLEMENT` journals. Settlement and refund of the same payment [run one at a time](serializable-scope.md): a refunded payment is never settled, and a refund of a settled payment also takes back the shops' shares.

## Example
For a sale of 10000 with a fee of 50, an order with shop A ([`subtotalMinor`](shop-subtotal.md) 6000) and shop B (4000) settles as follows (illustrative):
```
MARKETPLACE_CLEARING  -9950
SHOP_<A>              +5970
SHOP_<B>              +3980
```

## Known gaps
- The spec does not say how the ledger decides that an order "was settled" when it processes a refund, for example whether it looks for an existing `SETTLEMENT` journal.
- The spec does not say how the [`ledger.settle-order` job](job.md) relates to the settlement consumer.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-08, B-06
- [S14](../capabilities/S14-ledger-reconciliation.md): R-11, R-14
- [auction-sold](auction-sold.md)
- [auction-unit](auction-unit.md)
- [clawback](clawback.md)
- [job](job.md)
- [ledger-jobs](ledger-jobs.md)
- [record-payment-refunded](record-payment-refunded.md)
- [second-chance](second-chance.md)
- [serializable-scope](serializable-scope.md)
- [settlement-consumer](settlement-consumer.md)
- [settlement-journal](settlement-journal.md)
- [shop-share](shop-share.md)
<!-- used-by:end -->
