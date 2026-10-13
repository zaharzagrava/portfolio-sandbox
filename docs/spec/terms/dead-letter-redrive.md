---
id: dead-letter-redrive
title: Dead-letter redrive
kind: term
status: draft
aliases: [redrive]
defined_for: S53-events-projections
rules_hash: 0c98a2781522
---
# Dead-letter redrive
## Definition
A dead-letter redrive is an [operator action](operator.md) that moves [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue) events back to the topic they came from. Each event keeps the value it was originally routed by, so the [consumer](event-consumer.md) can process it again. Operators use it after fixing the cause of the failure, such as a handler bug or a [sink outage](event-sink.md). The redrive runs under its own [`<consumer>.redrive` consumer group](consumer-group.md) and reads from the consumer's [`<consumer>.dlq` topic](dead-letter-topic.md).

## Example
An operator fixes a handler that was failing with `HANDLER_FAILED`. Four events are waiting in the consumer's `.dlq` topic, so the operator runs:
```
pnpm projections:redrive
```
Each of the four events goes back to its source topic, for example `orders.events`, with its original `aggregateId` key.

## Known gaps
- The spec does not say which redrive-count header name is correct. AS-63 uses `x-redriven-count`, but `packages/backend/scripts/projections/redrive.ts` uses `x-redrive-count`.
- The spec does not say what happens if a redriven event fails again, for example whether there is a limit on how many times it can be redriven.
- The spec does not say which arguments `pnpm projections:redrive` accepts. They are parsed in `parseRedriveArgs`, but the page does not list them.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-14
- [consumer-group](consumer-group.md)
- [dead-letter-topic](dead-letter-topic.md)
- [event-consumer](event-consumer.md)
- [event-key](event-key.md)
- [event-sink](event-sink.md)
- [non-retryable-broker-error](non-retryable-broker-error.md)
- [operator](operator.md)
- [redrive-count-header](redrive-count-header.md)
<!-- used-by:end -->
