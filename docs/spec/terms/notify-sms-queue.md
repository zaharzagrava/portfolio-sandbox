---
id: notify-sms-queue
title: notify-sms queue
kind: term
status: draft
aliases: [notify-sms]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# notify-sms queue
## Definition
`notify-sms` is the delivery line for transactional SMS messages. The router puts an SMS delivery on it after the inbox item has been created and the quiet-hours check has passed. Workers on the line send each delivery through the SMS provider chain. Marketing SMS goes on its own line, `notify-marketing-sms`. That keeps a marketing backlog or a provider outage from delaying transactional texts. Before each send, a worker checks suppression, the user's current preference (non-mandatory types only) and the maximum age. A delivery that fails transiently, or is over the send budget, goes back to this same line.

## Example
An order update produces an SMS delivery for a user who turned on SMS and has a verified phone. The user's quiet hours end in 10 minutes (illustrative), which is within the queue-delay limit. So the router queues the delivery on `notify-sms` with a queue delay instead of scheduling a `notifications.wake-delivery` job. When the delay ends, a worker re-checks suppression, preference and maximum age before it calls the provider.

## Known gaps
- The spec does not say which queue technology backs this line. SQS is named only for `tenancy-invite-requested`.
- The spec does not say what worker capacity this line has. It only says marketing lines get lower capacity.
- The spec does not say which acceptance scenario proves the lines. The entry point lists `[proof: none]`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
