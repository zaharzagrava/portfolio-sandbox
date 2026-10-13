---
id: auctions-source-family
title: Auctions source family
kind: term
status: draft
aliases: [auctions source]
defined_for: S28-notifications
rules_hash: c3735a1c0100
---
# Auctions source family
## Definition
The auctions [source family](notification-family.md) is the group of auction events that the notifications capability listens to. Like every other source family, it has its own [event consumer](event-consumer.md) built on the [S53 framework](event-backbone.md). That consumer validates each payload against its type's schema and maps it to zero or more notification requests. It ignores a [known-unmapped type](known-unmapped-type.md) and counts it. It [dead-letters](dead-letter-topic.md) a malformed payload or an unsupported version. The version check works per aggregate and per family, so an auction event older than the [highest notified version](notified-version.md) is dropped.

## Example
An outbid event reaches the auctions consumer. It passes schema validation and maps to one notification request for the bidder who was outbid. The router creates the [inbox item](inbox-item.md) and announces it as event `notification` on `user:<userId>`. Then it applies preferences and [quiet hours](quiet-hours.md) before it hands a push to `notify-push`. (Illustrative: the spec does not list the auctions event types or how they map to notifications.)

## Known gaps
- The spec does not say which event types belong to the auctions family, which source topic the consumer reads, or what each type maps to.
- The spec does not say whether auction events carry a [monotonic aggregate version](monotonic-version.md). If they don't, the rule that drops stale versions may not apply to this family.
- The spec does not say the maximum age of each auction event type. Because of that, you can't tell when an auction notice gets an inbox item but no external delivery ([`expired`](pre-send-terminal-status.md)).

## Used by
<!-- used-by:start -->
- [dead-letter-topic](dead-letter-topic.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [inbox-item](inbox-item.md)
- [known-unmapped-type](known-unmapped-type.md)
- [monotonic-version](monotonic-version.md)
- [notification-family](notification-family.md)
- [notified-version](notified-version.md)
- [outbid-event](outbid-event.md)
- [quiet-hours](quiet-hours.md)
<!-- used-by:end -->
