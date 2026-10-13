---
id: provider-timeout
title: Provider timeout
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: d29f4ad1313d
---
# Provider timeout
## Definition
The provider timeout is how long a worker waits for one provider in the provider chain to answer a send. If the provider does not answer in that time, the worker treats it like a [transient failure](transient-failure.md). It then fails over to the next provider in the same [attempt](job-attempt.md). The worker does not wait for a new attempt through the [delivery line](notification-line.md). If every provider in the chain fails this way, the line retries the delivery with its usual [backoff](job-retry-delay.md).

## Example
A delivery on [`notify-sms`](notify-sms-queue.md) goes to the first SMS provider, which does not answer within 10 seconds. In the same attempt, the worker sends it to the next SMS provider in the chain. If that provider also times out and the chain has no more providers, the delivery goes back to `notify-sms` to retry. It can be retried up to 5 times, then it is [dead-lettered](dead-letter-topic.md) as `failed` with reason `exhausted`.

## Known gaps
- The spec does not say what happens when a provider actually sent the message but its answer arrived after the timeout. Failing over could then send the message twice. The [never-send-twice guard](never-send-twice-guard.md) only covers deliveries already recorded as `sent`.
- The spec does not say whether a timeout counts toward opening that provider's [circuit breaker ↗](../sw-external-terms.md#circuit-breaker).
- The spec does not say whether the timeout can be configured, or whether it differs by channel or by provider.

## Used by
<!-- used-by:start -->
- [dead-letter-topic](dead-letter-topic.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [job-attempt](job-attempt.md)
- [job-retry-delay](job-retry-delay.md)
- [never-send-twice-guard](never-send-twice-guard.md)
- [notification-line](notification-line.md)
- [provider-chain](provider-chain.md)
- [provider-failure](provider-failure.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
