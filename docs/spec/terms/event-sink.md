---
id: event-sink
title: Sink (event consumer)
kind: term
status: draft
aliases: [sink]
defined_for: S53-events-projections
rules_hash: e90efb4b893a
---
# Sink (event consumer)
## Definition
The sink is the external store that an [event consumer](event-consumer) writes its [effects](consumer-effects) to, usually a [read model](read-model.md). When the sink is unreachable, the consumer [pauses the partition](partition-pause) and does not [dead-letter](dead-letter-topic.md) events. Once the sink is back, it applies the events in order. A sink outage is a fault in the target, not in the event. Design intent (not stated in the spec): that is why it is not treated as an error in the code that processes the event.

## Example
A [projection consumer ↗](../sw-external-terms.md#projection) writes documents to Elasticsearch, so Elasticsearch is its sink. Say Elasticsearch is unreachable for 30 s. The partition pauses, nothing goes to `<consumer>.dlq`, and the events apply in order once it returns (S53.B-13).

## Known gaps
- The spec does not state rules for the specific sinks. Redis, Elasticsearch, DynamoDB, Cassandra and ClickHouse have tests (AS-66 to AS-70, AS-72), but no rule or behavior on the page covers them.
- The spec does not say how a consumer decides a sink is "unreachable" rather than raising a [permanent error](permanent-error). Examples would be connection errors only, or timeouts too.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-13
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-redrive](dead-letter-redrive.md)
- [dead-letter-topic](dead-letter-topic.md)
- [handler-failed](handler-failed.md)
- [partition-pause](partition-pause.md)
- [read-model](read-model.md)
<!-- used-by:end -->
