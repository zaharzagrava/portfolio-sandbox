---
id: payment-status-history
title: Payment status history
kind: term
status: draft
aliases: [history row]
defined_for: payment-lifecycle
rules_hash: 4c9502771949
---
# Payment status history
## Definition
Payment status history is the log of every status a payment has passed through. Each status change writes exactly one history row. The row is written in the same [transaction ↗](../sw-external-terms.md#database-transaction) as the [guarded update](guarded-update.md) on status and version, together with any [outbox event](inbox-table.md). If the transaction rolls back, the status change, the history row and the event all disappear together. Design intent (not stated in the spec): this gives an audit trail that always matches the payment's current status.

## Example
A provider call times out after the charge was sent, so the payment moves from `PENDING` to [`UNKNOWN`](payment-status.md). One transaction does three things:
```
UPDATE payment SET status='UNKNOWN', version=8 WHERE id='pay_123' AND status='PENDING' AND version=7   -- illustrative values
INSERT history row (pay_123: PENDING -> UNKNOWN)
[outbox.append](outbox-append.md)(payment status event)
```

## Known gaps
- The spec does not say which fields a history row holds, such as the reason, actor or timestamp.
- The spec does not say whether the history can be read through an API or how long it is kept.
- Not confirmed in the code: whether a guarded update that fails, because of a version or status mismatch, leaves any trace in the history.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-10, R-20
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-07
- [decide-payment-status](decide-payment-status.md)
- [guarded-update](guarded-update.md)
- [inbox-table](inbox-table.md)
- [payment-status](payment-status.md)
- [payment-succeeded-event](payment-succeeded-event.md)
<!-- used-by:end -->
