---
id: settlement-consumer
title: Settlement consumer
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: 06e7d9bdcf7b
---
# Settlement consumer
## Definition
The settlement consumer is `SettlementConsumer`. It reads [`order.paid`](order-paid-event.md) events from the [`orders.events` topic](orders-events-topic.md) in [consumer group `ledger-settlement`](consumer-group.md). For each paid order it posts one [`SETTLEMENT` journal](settlement-journal.md) that pays each shop its share. It validates every payload, and it sends invalid payloads to the [dead-letter topic](dead-letter-topic.md) without any effect. Duplicate or out-of-order events cause no double posting. If the payment's `SALE` journal does not exist yet, it waits and retries a limited number of times. Design intent (not stated in the spec): the retries exist because payment capture and `order.paid` travel separate paths, so either can arrive first.

## Example
`order.paid` for an order arrives before `recordPaymentCaptured` has posted the `SALE` journal. The consumer defers it, up to 6 attempts over about 10 minutes. Once the sale exists, it posts the `SETTLEMENT` journal. A redelivery of the same event later returns the existing journal.

## Known gaps
- The spec does not say what happens when the sale still does not exist after the last attempt (dead-letter, alert or silent drop).
- The spec does not list the `order.paid` payload fields the consumer validates, beyond `subtotalMinor` and the shop ids.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-15
- [consumer-group](consumer-group.md)
- [dead-letter-topic](dead-letter-topic.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-journal-kinds](ledger-journal-kinds.md)
- [ledger-settle-order-job](ledger-settle-order-job.md)
- [ledger](ledger.md)
- [order-settlement](order-settlement.md)
- [orders-events-topic](orders-events-topic.md)
- [settled-sale](settled-sale.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
