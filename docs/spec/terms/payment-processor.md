---
id: payment-processor
title: Payment processor
kind: term
status: draft
aliases: [processor]
defined_for: payment-lifecycle
rules_hash: 4846ddbf619e
---
# Payment processor
## Definition
The payment processor is the asynchronous worker that takes a queued request to charge an order and asks the [payment provider](payment-provider.md) to make that charge. Right before calling the provider, it checks again that the order is still [`RESERVED`](reservation-status.md) and that its [reservedUntil](reserved-until.md) has not passed. If either check fails, it cancels the payment without calling the provider. [A redelivered command never leads to a second provider charge.](at-least-once-delivery.md) If the provider times out or returns a `5xx` after the charge was sent, the processor marks the payment [`UNKNOWN`](unknown-payment-outcome.md) and does not resend the charge.

## Example
A payment command for an order arrives after that order's reservedUntil. The processor sets the payment to [`CANCELLED`](payment-status.md) and makes 0 provider calls.

## Known gaps
- The spec does not say what runs the processor, for example an [event consumer](event-consumer.md) or a [queued job](job-enqueue.md), or how the command reaches it.
- Not confirmed in the code: how the processor detects a redelivered command, for example through [attempt fencing](attempt-fencing.md) or the [consumer deduplication mode](consumer-deduplication-mode.md).

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-12, B-08
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-03
- [at-least-once-delivery](at-least-once-delivery.md)
- [attempt-fencing](attempt-fencing.md)
- [check-payment-money](check-payment-money.md)
- [classify-charge](classify-charge.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [crash-recovery](crash-recovery.md)
- [decide-payment-status](decide-payment-status.md)
- [event-consumer](event-consumer.md)
- [find-mismatch](find-mismatch.md)
- [job-enqueue](job-enqueue.md)
- [order-not-payable](order-not-payable.md)
- [payment-command](payment-command.md)
- [payment-provider](payment-provider.md)
- [reserved-until](reserved-until.md)
- [terminal-payment-status](terminal-payment-status.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
