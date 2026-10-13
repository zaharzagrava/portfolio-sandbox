---
id: queue-delay
title: Queue delay
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 6eabb5dd2428
---
# Queue delay
## Definition
The queue delay is a wait set on a message when it is put on a [delivery line](notification-channel.md). The line does not hand the message to a worker until the wait is over. [The router](notification-router.md) uses it for short waits, such as a push or SMS held for [quiet hours](quiet-hours.md). Longer waits use one [`notifications.wake-delivery`](notifications-wake-delivery-job.md) job per delivery instead.

## Example
A push is routed at 21:50 and the recipient's quiet hours end at 22:00 (illustrative times). The wait is 600 seconds, which is within the queue-delay limit. The message goes on [`notify-push`](notify-push.md) with a 600-second delay, and no job is scheduled.

## Known gaps
- The spec does not say which queue technology backs the `notify-*` lines. The 900-second limit is the same as the [SQS ↗](../sw-external-terms.md#sqs-queue) maximum message delay, but the spec does not confirm that the lines run on SQS.
- The spec does not say whether the [retry-after wait](retry-after-seconds.md) (R-31) and the backoff retries (R-34) also use the queue delay. The backoff limit of 900 s suggests they do, but this is not stated.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-26
- [notification-channel](notification-channel.md)
- [notification-router](notification-router.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
- [notify-push](notify-push.md)
- [push-notification](push-notification.md)
- [quiet-hours](quiet-hours.md)
- [retry-after-seconds](retry-after-seconds.md)
<!-- used-by:end -->
