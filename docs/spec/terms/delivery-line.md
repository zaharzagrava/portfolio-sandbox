---
id: delivery-line
title: Delivery line
kind: term
status: draft
aliases: [lines]
defined_for: S28-notifications
rules_hash: 8615b0827e6d
---
# Delivery line
## Definition
A delivery line is the queue and its workers for one channel. Its workers take deliveries off the queue and hand them to providers. E-mail, SMS and push each have a [transactional line](transactional-send.md), and each channel also has a separate marketing line. Because the lines are separate, a backlog or provider outage on one line never delays another. [Deliveries](delivery.md) go back onto their line when they are over the [send budget](send-budget.md), or when they retry with [backoff](job-retry-delay.md) after a [transient failure](transient-failure.md) of the whole [provider chain](provider-chain.md).

## Example
The lines are `notify-email`, `notify-sms`, `notify-push`, `notify-marketing-email`, `notify-marketing-sms` and `notify-marketing-push`. A big campaign that fills `notify-marketing-email` does not delay a password-reset e-mail on `notify-email`.

## Known gaps
- The spec does not say which queue technology backs the lines. The only queue it names as SQS is `tenancy-invite-requested`.
- The spec gives no proof (acceptance scenario) for the line names themselves.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-30, R-31
- [delivery](delivery.md)
- [job-retry-delay](job-retry-delay.md)
- [notify-marketing-push](notify-marketing-push.md)
- [provider-chain](provider-chain.md)
- [queue-refusal](queue-refusal.md)
- [send-budget](send-budget.md)
- [transactional-send](transactional-send.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
