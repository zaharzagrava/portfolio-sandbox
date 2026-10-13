---
id: notify-push
title: notify-push
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: db1f26c93c53
---
# notify-push
## Definition
`notify-push` is the delivery line for push notifications that are not marketing. Marketing push messages use their own line, `notify-marketing-push`. Because the lines are separate, a backlog or outage on one line never delays another. A push delivery waits on this line until a worker takes it and sends it through the [push provider chain](provider-chain.md). If the whole chain fails with a [transient error](transient-error.md), or the provider's [send budget](send-budget.md) is used up, the delivery comes back to this line.

## Example
An order update for a buyer during their [quiet hours](quiet-hours.md) goes onto `notify-push` with a delay. A short delay uses the [queue delay](queue-delay.md). A long delay uses one `notifications.wake-delivery` job instead. At the [wake instant](wake-instant.md), the worker checks the maximum age, suppression and the buyer's current preference again before sending.

## Known gaps
- The spec does not say which queue technology carries the line. The only SQS queue it names is `tenancy-invite-requested`.
- The spec does not give the worker capacity of `notify-push` or of `notify-marketing-push`. It only says the marketing line has lower capacity.
- The spec gives no proof scenario for the lines as entry points (`[proof: none]`).

## Used by
<!-- used-by:start -->
- [provider-chain](provider-chain.md)
- [push-notification](push-notification.md)
- [queue-delay](queue-delay.md)
- [quiet-hours](quiet-hours.md)
- [send-budget](send-budget.md)
- [transient-error](transient-error.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
