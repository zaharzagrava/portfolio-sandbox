---
id: partition-pause
title: Partition pause
kind: term
status: draft
aliases: [pause, pauses]
defined_for: S53-events-projections
rules_hash: e3ae0a82742c
---
# Partition pause
## Definition
A partition pause is how a consumer reacts when its [sink](event-sink) is unreachable. It stops taking new events from the affected [Kafka partition ↗](../sw-external-terms.md#kafka-partition) and does not [commit offsets ↗](../sw-external-terms.md#kafka-offset-commit) past them. Nothing is [dead-lettered](dead-letter-topic.md) while the partition is paused. When the [sink](event-sink.md) comes back, the consumer resumes and applies the waiting events in their original order. Offsets are committed only after [effects](consumer-effects.md) (S53.R-20), so an event is never lost while the partition is paused.

## Example
A consumer's sink is down for 30 s while events A1, A2 and A3 arrive on one partition. The partition pauses. After the sink returns, A1, A2 and A3 apply in that order, and `<consumer>.dlq` stays empty (S53.B-13).

## Known gaps
- The spec does not say how long a partition may stay paused. It also does not say whether a long outage eventually dead-letters events or raises an alert.
- The spec does not say how the consumer detects that the sink is back, for example by probing or retrying on a timer.
- The spec does not say whether other partitions of the same [consumer group](consumer-group) keep processing during the pause.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-13
- [consumer-effects](consumer-effects.md)
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-topic](dead-letter-topic.md)
- [dlq-write-failures-total](dlq-write-failures-total.md)
- [event-sink](event-sink.md)
- [permanent-error](permanent-error.md)
<!-- used-by:end -->
