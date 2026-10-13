---
id: ledger-settle-order-job
title: ledger.settle-order job
kind: term
status: draft
aliases: [ledger.settle-order]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ledger.settle-order job
## Definition
`ledger.settle-order` is one of the background jobs the ledger registers in [`LedgerJobs`](ledger-jobs.md), and the [job scheduler](job.md) runs it. Its name suggests that it settles a single order, meaning it posts that order's [`SETTLEMENT` journal](settlement-journal.md). The [settlement consumer](settlement-consumer.md) posts that journal when [`order.paid`](order-paid-event.md) arrives on [`orders.events`](orders-events-topic.md). If the sale has not been recorded yet, the consumer defers and retries within its [attempt budget](consumer-attempt-budget.md). Running settlement as a job would let that retry happen outside the consumer. This is design intent (not stated in the spec). Like every settlement, it is serialized with refunds of the same payment, and the store makes it [idempotent ↗](../sw-external-terms.md#idempotency) through the journal's [(kind, reference)](journal-kind-reference.md).

## Example
An `order.paid` event arrives before [`recordPaymentCaptured`](record-payment-captured.md) has posted the order's `SALE` journal. Settlement is deferred and tried again later. When the sale exists, one `SETTLEMENT` journal debits [`MARKETPLACE_CLEARING`](ledger-system-accounts.md) and credits each `SHOP_<uuid>` its share. A second run returns the existing journal with [`created: false`](enqueue-created-flag.md).
```
job type: ledger.settle-order   payload: { orderId: "<order uuid>" }   (payload is illustrative)
```

## Known gaps
- The spec does not say what triggers `ledger.settle-order`. It could be the consumer's deferral path, a schedule, or a manual re-run by an operator.
- The spec does not say what the job's payload is. It also does not say which reference (order id or payment id) makes the resulting `SETTLEMENT` journal unique.
- Not confirmed in the code: whether this job's attempts are the "up to 6 attempts in about 10 minutes" deferral in S14.R-16, or a separate retry budget from the job layer.

## Used by
<!-- used-by:start -->
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [job](job.md)
- [journal-kind-reference](journal-kind-reference.md)
- [settlement-consumer](settlement-consumer.md)
- [settlement-journal](settlement-journal.md)
<!-- used-by:end -->
