---
id: billing-source-family
title: Billing source family
kind: term
status: draft
aliases: [billing source]
defined_for: S28-notifications
rules_hash: bbad4905b029
---
# Billing source family
## Definition
The billing source family is the group of billing events that this capability consumes. It has its own event consumer, built on the [S53 consumer framework](event-consumer.md), like every other source family. The consumer checks each billing payload against the schema of its type and maps it to zero or more notification requests. It counts and ignores a [known-unmapped type](known-unmapped-type.md), and [dead-letters](dead-letter-topic.md) a malformed payload or an [unsupported version](unsupported-version.md). Billing code only publishes the event: routing, rendering and delivery all happen in this capability.

## Example
A seller's bank asks them to confirm a subscription payment. Billing publishes an event, and the billing consumer maps it to a notification with its own confirmation text. The seller has locale `uk`, so the [inbox item](inbox-item.md) is rendered in Ukrainian.

## Known gaps
- The spec does not say which billing event types the consumer maps, which ones it ignores as known-unmapped, or their event names.
- The spec does not say which billing notifications are [mandatory types](mandatory-notification-type.md) and which are marketing, so it is unclear which ones ignore opt-outs and quiet hours.
- Not confirmed in the code: the billing consumer itself. The entry-point proofs (S28 AS-01, AS-08) cover consumers in general and do not name billing.

## Used by
<!-- used-by:start -->
- [dead-letter-topic](dead-letter-topic.md)
- [event-consumer](event-consumer.md)
- [inbox-item](inbox-item.md)
- [known-unmapped-type](known-unmapped-type.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [payment-confirmation-challenge](payment-confirmation-challenge.md)
- [unsupported-version](unsupported-version.md)
<!-- used-by:end -->
