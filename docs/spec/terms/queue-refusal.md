---
id: queue-refusal
title: Queue refusal
kind: term
status: draft
aliases: [refuses]
defined_for: S28-notifications
rules_hash: c3ea7ceb7f6b
---
# Queue refusal
## Definition
A queue refusal is a fault where a [delivery line](delivery-line.md) will not accept a delivery the [router](notification-router.md) hands to it. An [acceptance scenario](acceptance-scenario.md) uses it to prove that [routing steps](routing-step.md) are safe to repeat. The earlier steps, such as the [inbox item](inbox-item.md), stay in place, and the event stays retriable. Replaying the event must reach the same final state as one uninterrupted run, with no duplicates.

## Example
The router creates a user's inbox item, then hands an SMS delivery to [`notify-sms`](notify-sms-queue.md), which refuses once. The event is [replayed](event-replay.md). The inbox item already exists under the same [dedupe identity](dedupe-identity.md), so it is not created again, and the SMS is queued exactly once.

## Known gaps
- The spec does not say whether a refusal uses up an attempt in the [consumer attempt budget](consumer-attempt-budget.md).
- The spec does not say what the [delivery timeline](delivery-timeline.md) shows between the refusal and the successful retry.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-03
- [acceptance-scenario](acceptance-scenario.md)
- [consumer-attempt-budget](consumer-attempt-budget.md)
- [dedupe-identity](dedupe-identity.md)
- [delivery-line](delivery-line.md)
- [delivery-timeline](delivery-timeline.md)
- [event-replay](event-replay.md)
- [inbox-item](inbox-item.md)
- [notification-router](notification-router.md)
- [routing-step](routing-step.md)
<!-- used-by:end -->
