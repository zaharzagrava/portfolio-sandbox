---
id: never-send-twice-guard
title: Never-send-twice guard
kind: term
status: draft
aliases: [never send twice]
defined_for: S28-notifications
rules_hash: ca90840232d6
---
# Never-send-twice guard
## Definition
The never-send-twice guard is the check that stops a delivery from reaching a provider a second time once it has been sent. It is keyed on the delivery id. It holds when the same queue message comes back after a retry or a [redelivery](webhook-redelivery.md), and when [concurrent copies of a delivery](concurrent-delivery-copies.md) run at the same time. A failed write to the delivery timeline must not cause a repeat send either. This works alongside the done marker and the dedupe identity, so no single shortcut is the only protection against duplicate messages.

## Example
Two concurrent copies of delivery `d-7f3a` (illustrative) are picked up from the `notify-email` line by two workers. One copy hands the e-mail to the provider, and the delivery becomes `sent`. The other copy finds that `d-7f3a` was already sent and stops without calling any provider.

## Known gaps
- The spec does not say how the guard is enforced. It could be a [conditional write](durable-conditional-write.md) on the delivery status, a lock, or a [claim](write-behind-claim.md) recorded before the send.
- The spec does not say what happens when a worker crashes after the provider accepted the message but before the send was recorded. A later attempt could skip the send (the message is sent at most once) or send it again.
- The spec does not say what a blocked copy writes to the delivery timeline, if it writes anything.

## Used by
<!-- used-by:start -->
- [concurrent-delivery-copies](concurrent-delivery-copies.md)
- [delivery-id](delivery-id.md)
- [durable-conditional-write](durable-conditional-write.md)
- [provider-timeout](provider-timeout.md)
- [webhook-redelivery](webhook-redelivery.md)
- [write-behind-claim](write-behind-claim.md)
<!-- used-by:end -->
