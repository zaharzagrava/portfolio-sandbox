---
id: per-aggregate-ordering
title: Per-aggregate event ordering
kind: term
status: draft
aliases: [event order per aggregate]
defined_for: outbox-task-queue
rules_hash: f4d5ef029c5c
---
# Per-aggregate event ordering
## Definition
The [relay](outbox-relay.md) must publish the events of one [aggregate](aggregate-id.md) in the order they were written. It does this by keying each message by [`aggregateId`](aggregate-id.md), and by holding back later rows while an earlier row of the same aggregate is retrying. There is no ordering promise across different aggregates. A [parked](parked-row.md) row stops blocking its aggregate, so later events of that aggregate can then go out without it.

## Example
For product `prod_123` (illustrative), "price changed" fails to send and goes into [backoff](job-retries.md). "Product deleted" for the same product waits behind it. Events for other products keep flowing.

## Known gaps
- The spec does not say how consumers handle the gap left when a row is parked and later events of the same aggregate are published without it. A [`versionGuard`](version-guard.md) consumer may detect the gap, but no rule says so.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-13
- [S51](../capabilities/S51-realtime-push.md): B-15
- [S53](../capabilities/S53-events-projections.md): R-05, R-12, B-05
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-04, C-06
- [aggregate-id](aggregate-id.md)
- [job-retries](job-retries.md)
- [orders-events-topic](orders-events-topic.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
- [subscription-plan-changed-event](subscription-plan-changed-event.md)
<!-- used-by:end -->
