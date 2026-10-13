---
id: send-budget
title: Send budget
kind: term
status: draft
aliases: [budget]
defined_for: S28-notifications
rules_hash: e7f908c67a94
---
# Send budget
## Definition
A send budget is the rate limit on how fast deliveries may be handed to one provider. The rate limiter enforces it. If a delivery would go over the budget, it goes back onto its [delivery line](notification-channel.md) with the limiter's [retry-after delay](retry-after-ms.md). This does not use up one of its [attempts](job-attempt.md). If the limiter itself is down, [transactional sends](transactional-send.md) go ahead (fail open) and marketing sends are held back (fail closed).

## Example
Suppose the SES budget is used up for the current window (illustrative). A delivery on `notify-email` is put back on the line, delayed by the retry-after value (for example 2 s, illustrative). Its attempt count stays the same.

## Known gaps
- The spec does not say what the budget values are for each provider.
- The spec does not say whether an over-budget provider triggers failover to the next [provider in the chain](provider-chain.md), or only sends the delivery back to its line.
- The spec does not say whether transactional and marketing lines share one budget per provider.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-31
- [delivery-line](delivery-line.md)
- [exhausted](exhausted.md)
- [fallback-provider](fallback-provider.md)
- [job-attempt](job-attempt.md)
- [mail-provider](mail-provider.md)
- [marketing-cap](marketing-cap.md)
- [notification-channel](notification-channel.md)
- [notification-queue](notification-queue.md)
- [notify-email-queue](notify-email-queue.md)
- [notify-marketing-email-queue](notify-marketing-email-queue.md)
- [notify-push](notify-push.md)
- [provider-chain](provider-chain.md)
- [retry-after-ms](retry-after-ms.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->
