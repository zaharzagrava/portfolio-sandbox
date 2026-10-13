---
id: known-unmapped-type
title: Known-unmapped type
kind: term
status: draft
aliases: [known-unmapped]
defined_for: S28-notifications
rules_hash: de8f7e1cbfc4
---
# Known-unmapped type
## Definition
A known-unmapped type is an event type the [notification consumer](event-consumer.md) recognises but that maps to no notification. The consumer does not treat it as an error. It ignores the event and increments a counter. This is different from a [malformed payload](malformed-queue-message.md) or an [unsupported version](unsupported-version.md), which go to the [dead-letter topic](dead-letter-topic.md) with a [reason](dead-letter-reason-code.md) and [the event id](event-id.md).

## Example
Suppose (illustrative) the orders consumer receives an `order.reserved` event that passes its [schema check](schema-invalid.md), and the mapping returns zero [notification requests](notification-routing.md). The event is [acknowledged ↗](../sw-external-terms.md#kafka-offset-commit), the ["ignored" counter](consumer-outcomes.md) goes up by one, and nothing reaches [the inbox](inbox-item.md), [the bell](notification-channel.md) or any line.

## Known gaps
- The spec does not say which event types are known-unmapped, or where that list is declared.
- The spec does not name the counter or say whether it is labelled by event type.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-01
- [auctions-source-family](auctions-source-family.md)
- [billing-source-family](billing-source-family.md)
- [consumer-outcomes](consumer-outcomes.md)
- [dead-letter-reason-code](dead-letter-reason-code.md)
- [dead-letter-topic](dead-letter-topic.md)
- [event-consumer](event-consumer.md)
- [event-id](event-id.md)
- [inbox-item](inbox-item.md)
- [malformed-queue-message](malformed-queue-message.md)
- [notification-channel](notification-channel.md)
- [notification-routing](notification-routing.md)
- [schema-invalid](schema-invalid.md)
- [unsupported-version](unsupported-version.md)
<!-- used-by:end -->
