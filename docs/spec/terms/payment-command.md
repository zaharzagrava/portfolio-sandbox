---
id: payment-command
title: Payment command
kind: term
status: draft
aliases: [payment commands]
defined_for: payment-lifecycle
rules_hash: aa432ce44dce
---
# Payment command
## Definition
A payment command is the asynchronous instruction that tells the [payment processor](payment-processor.md) to charge one payment with the [payment provider](payment-provider.md). The processor acts on it later, not inside the buyer's request. Before the processor uses a command to call the provider, it checks again that the order is still [`RESERVED`](reservation-status.md) and that its [reservedUntil](reserved-until.md) has not passed. The command may be delivered more than once, but a redelivered command must never cause a second provider charge. Design intent (not stated in the spec): because the charge happens asynchronously, a slow or silent provider never blocks the buyer's request.

## Example
The payment command for one order is delivered twice. The processor sends the charge to the payment provider once. The second delivery causes 0 new provider calls. If the first call timed out after the charge was sent, the payment stays [`UNKNOWN`](unknown-payment-outcome.md) and the charge is not sent again.

## Known gaps
- The spec does not say what creates the payment command or how it reaches the processor, for example an outbox event or a queued job. It also does not say whether the payment intent request is what triggers it.
- The spec does not say what fields the command carries. The amount and currency come from the order copy, but it is not stated whether the command carries them or the processor reads them.
- Not confirmed in the code: how a redelivered command is detected and stopped, for example by attempt fencing, the consumer deduplication mode or the payment status guard.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-10, R-16, B-01
- [amount-out-of-range](amount-out-of-range.md)
- [check-payment-money](check-payment-money.md)
- [payment-processor](payment-processor.md)
- [payment-provider](payment-provider.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [reserved-until](reserved-until.md)
- [terminal-payment-status](terminal-payment-status.md)
<!-- used-by:end -->
