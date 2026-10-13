---
id: worker-capacity
title: Worker capacity
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: 08be5b7b1e0b
---
# Worker capacity
## Definition
Worker capacity is how many deliveries a [delivery line](notification-line.md) can work on at the same time. [Marketing lines](notification-line.md) get less capacity than the [transactional lines](transactional-send.md) of the same [channel](notification-channel.md). The page's stated purpose is that a marketing campaign never blocks the rest. Lower capacity limits how much marketing work can run at once, on top of the separation into different lines.

## Example
Illustrative only: [`notify-email`](notify-email-queue.md) might run with 20 concurrent workers and [`notify-marketing-email`](notify-marketing-email-queue.md) with 4. A campaign backlog then drains slowly while transactional e-mail keeps its full throughput.

## Known gaps
- The spec does not say the actual capacity values, or how much lower the marketing lines are.
- The spec does not say whether capacity is counted per worker instance or across the whole fleet.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-30
- [email-line](email-line.md)
- [marketing-delivery](marketing-delivery.md)
- [marketing-email](marketing-email.md)
- [notification-channel](notification-channel.md)
- [notification-line](notification-line.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [notify-marketing-push](notify-marketing-push.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->
