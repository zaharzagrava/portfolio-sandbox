---
id: transient-failure
title: Transient failure
kind: term
status: draft
aliases: [transient]
defined_for: S28-notifications
rules_hash: dece62dd1575
---
# Transient failure
## Definition
A transient failure is a provider error that might succeed if the same send is tried again soon. Examples are an outage, overload or a short network problem. A provider timeout counts the same way. On a transient failure the worker moves to the next provider in the provider chain within the same [attempt](job-attempt.md). If every provider in the chain fails this way, the [delivery](delivery.md) goes back to its [line](notification-line.md) and is retried with [backoff](job-retry-delay.md). When the attempts run out, it is [dead-lettered](dead-letter-topic.md) as [`failed`](delivery-status.md) with reason [`exhausted`](exhausted.md).

## Example
Push provider 1 returns an error that means "service unavailable" (illustrative), so the worker tries push provider 2. Provider 2 also fails transiently, so the whole attempt is retried. The backoff starts at 30 s, doubles each time, is capped at 900 s and uses [full jitter](jitter.md). There are at most 5 attempts.

## Known gaps
- The spec does not say which provider answers (status codes, error kinds) count as transient and which count as [permanent](permanent-error.md).
- The spec does not say whether a send that is returned for being over the provider's send budget is handled like a transient failure. The spec only says such a send uses no attempt.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-32
- [S46](../capabilities/S46-shopping-assistant.md): R-38
- [dead-letter-topic](dead-letter-topic.md)
- [delivery-line](delivery-line.md)
- [delivery](delivery.md)
- [exhausted](exhausted.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [jitter](jitter.md)
- [job-attempt](job-attempt.md)
- [job-retry-delay](job-retry-delay.md)
- [mail-provider](mail-provider.md)
- [notification-line](notification-line.md)
- [notify-email-queue](notify-email-queue.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [provider-failure](provider-failure.md)
- [provider-timeout](provider-timeout.md)
<!-- used-by:end -->
