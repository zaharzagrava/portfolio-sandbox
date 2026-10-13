---
id: concurrent-delivery-copies
title: Concurrent copies of a delivery
kind: term
status: draft
aliases: [copies]
defined_for: S28-notifications
rules_hash: 2e88f69d77ff
---
# Concurrent copies of a delivery
## Definition
Concurrent copies are two or more copies of the same delivery message that are being processed at the same time. Copies appear because queues [redeliver](webhook-redelivery.md) messages under [at-least-once publication ↗](../sw-external-terms.md#at-least-once-delivery). A redelivery can also overlap with a retry. The rules require that a delivery that has already been sent is never handed to a provider again, even when the copies run in parallel. Only one copy may call the provider. The others must see that the delivery is already sent and stop.

## Example
Two workers on [`notify-sms`](notify-sms-queue.md) receive the same delivery (illustrative id `d-123`) at the same moment. One worker sends it. The other must not call the SMS provider, so the user gets exactly one text message.

## Known gaps
- The spec does not say how only one copy is allowed to send, for example a [conditional status write](durable-conditional-write.md) or a [lock ↗](../sw-external-terms.md#distributed-lock).
- The spec does not say how a crash between "provider accepted the message" and "recorded as sent" is handled. A crash at that point could still produce a duplicate send.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-35
- [delivery-id](delivery-id.md)
- [durable-conditional-write](durable-conditional-write.md)
- [never-send-twice-guard](never-send-twice-guard.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->
