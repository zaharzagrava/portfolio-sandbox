---
id: transient-error
title: Transient error
kind: term
status: draft
aliases: [transient]
defined_for: S28-notifications
rules_hash: 4228f8a4ff38
---
# Transient error
## Definition
A transient error is a [provider failure](provider-failure.md) that may succeed if tried again, for example a temporary outage. A provider timeout counts as transient too. [The delivery fails over](failover-timeline-entry.md) to the next provider in the channel's [ordered chain](provider-chain.md) within the same [attempt](job-attempt.md). If the whole chain fails transiently, the line retries with [exponential backoff ↗](../sw-external-terms.md#exponential-backoff) and [jitter](jitter.md). After the maximum attempts, the delivery is [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue) as `failed` with reason [`exhausted`](exhausted.md). A [permanent error](permanent-error.md), by contrast, never fails over or retries.

## Example
The primary e-mail provider returns a temporary error (or does not answer within 10 seconds). The same attempt sends through the next provider, and the [timeline](delivery-timeline.md) records `failover`. If every provider fails, the delivery returns to [`notify-email`](notify-email-queue.md) with a 30 s base backoff, doubling, capped at 900 s, for at most 5 attempts.

## Known gaps
- The spec does not say which provider responses (status codes or error kinds) count as transient or as permanent.
- Not confirmed in the code: where the transient/permanent classification lives for each provider.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-09
- [delivery-timeline](delivery-timeline.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [fallback-provider](fallback-provider.md)
- [jitter](jitter.md)
- [job-attempt](job-attempt.md)
- [notify-push](notify-push.md)
- [permanent-error](permanent-error.md)
- [provider-chain](provider-chain.md)
- [provider-failure](provider-failure.md)
<!-- used-by:end -->
