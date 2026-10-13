---
id: non-retryable-broker-error
title: Non-retryable broker error
kind: term
status: draft
aliases: [non-retryable]
defined_for: S53-events-projections
rules_hash: 37d74690ccb5
---
# Non-retryable broker error
## Definition
A non-retryable broker error is a [Kafka ↗](../sw-external-terms.md#kafka-topic) failure that sending the same row again will not fix. When the [outbox relay](outbox-relay.md) gets one, it [parks the row](parked-row.md) at once instead of retrying with [backoff](job-retry-delay.md). Once parked, the row no longer holds back later rows of the same [aggregate](aggregate-id.md). An [operator](operator.md) can then [requeue](dead-letter-redrive.md) it.

## Example
The relay tries to publish row A1, and the broker answers with an error classed as non-retryable. A1 becomes parked after its first attempt, and A2 and A3 of the same aggregate are free to publish. Possible examples are Kafka's "message too large" or "topic authorization failed" errors, but these are illustrative only.

## Known gaps
- The spec does not say which broker errors count as non-retryable.
- Not confirmed in the code: how the relay classifies broker errors into retryable and non-retryable.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-13
- [aggregate-id](aggregate-id.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [job-retry-delay](job-retry-delay.md)
- [operator](operator.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
- [pending-row](pending-row.md)
<!-- used-by:end -->
