---
id: settlement-journal
title: SETTLEMENT journal
kind: term
status: draft
aliases: [journal, settlement]
defined_for: S14-ledger-reconciliation
rules_hash: ff7dea263be0
---
# SETTLEMENT journal
## Definition
A `SETTLEMENT` journal moves a sale's net amount from [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) to the shops in an order. The settlement consumer posts exactly one per [`order.paid`](order-paid-event.md), reading [`orders.events`](orders-events-topic.md) in [consumer group `ledger-settlement`](consumer-group.md). It debits the sale's [clearing credit](clearing-credit.md) and credits each shop a share in proportion to its [`subtotalMinor`](shop-subtotal.md). Shares are rounded by [largest remainder ↗](../sw-external-terms.md#largest-remainder-method), and ties go to the lowest shop id. Only the ledger may post this kind of journal. If the sale has not been recorded yet, the consumer [defers and retries within a bounded number of attempts](consumer-attempt-budget.md).

## Example
Payment of 1001 [minor units](minor-units.md) with a fee of 50, so the net is 951. Two shops each have a subtotal of 500 (illustrative):
```
MARKETPLACE_CLEARING  -951
SHOP_<uuid-a>         +476   (lower id, wins the tie)
SHOP_<uuid-b>         +475
```

## Known gaps
- The spec does not say which reference a `SETTLEMENT` journal is unique on (order id or payment id). That matters because journals are unique per (kind, reference).
- The spec does not say how the [`ledger.settle-order` job](ledger-settle-order-job.md) relates to the consumer, for example whether it is the deferral mechanism or a manual re-run.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-07, B-08
- [clearing-credit](clearing-credit.md)
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [consumer-group](consumer-group.md)
- [ledger-settle-order-job](ledger-settle-order-job.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [minor-units](minor-units.md)
- [order-settlement](order-settlement.md)
- [orm-association](orm-association.md)
- [settled-sale](settled-sale.md)
- [settlement-consumer](settlement-consumer.md)
<!-- used-by:end -->
