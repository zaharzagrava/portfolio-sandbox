---
id: reversing-journal
title: Reversing journal
kind: term
status: draft
aliases: [journal]
defined_for: S13-payment-intents
rules_hash: dd3f74dd3c3a
---
# Reversing journal
## Definition
A reversing journal is the set of new ledger records that cancel out the entries made in the ledger when a payment completed. The [refund worker](refund.md) writes it when a refund finishes and the payment moves from [`REFUND_PENDING`](payment-status.md) to `REFUNDED`. The original entries stay in the ledger, and the new ones offset them so the net effect of the payment becomes zero. Design intent (not stated in the spec): the ledger is [append-only ↗](../sw-external-terms.md#append-only). A refund is recorded as new entries rather than by editing or deleting the original ones, so the full money trail stays auditable.

## Example
1. The provider answers "succeeded" for a payment. The payment becomes `COMPLETED`, and the system writes a ledger posting for its amount.
2. Later, [`orders.refund_requested`](orders-refund-requested-event.md) arrives for that payment. It moves to `REFUND_PENDING`, then to `REFUNDED`, and a reversing journal is written that offsets the original posting.

## Known gaps
- The spec does not say what a reversing journal looks like: which accounts it touches, how many rows it has, or how it links back to the original posting.
- The spec does not say whether the reversing journal is written in the same transaction as the `REFUNDED` status change and its history row.
- The spec does not say how partial refunds are journaled. Only full refunds are described (`orders-refund-requested` asks for a full refund).

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-11, B-13
- [S13](../capabilities/S13-payment-intents.md): B-18
- [S14](../capabilities/S14-ledger-reconciliation.md): R-03
- [failure-code](failure-code.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-entry-table](ledger-entry-table.md)
- [ledger-journal](ledger-journal.md)
- [ledger-posting](ledger-posting.md)
- [ledger-store](ledger-store.md)
- [ledger](ledger.md)
- [orders-refund-requested-event](orders-refund-requested-event.md)
- [payout-destination](payout-destination.md)
- [payout-failed-event](payout-failed-event.md)
- [payout-status](payout-status.md)
- [payout-transfer](payout-transfer.md)
- [payouts-domain](payouts-domain.md)
- [refund](refund.md)
<!-- used-by:end -->
