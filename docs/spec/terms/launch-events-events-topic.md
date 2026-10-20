---
id: launch-events-events-topic
title: launch-events.events topic
kind: term
status: draft
aliases: [launch-events.events]
defined_for: J03-launch-day
rules_hash: d6c329ad5b1d
---
# launch-events.events topic
## Definition
The `launch-events.events` topic is the [event-backbone](event-backbone.md) topic that carries the facts of launch events. The launch-day journey reads it, so other domains can react to bookings without calling the launch-events domain. Events are appended in the [same transaction](outbox-append.md) as the state change, so no booking exists without its event. Consumers such as the notification router read it at their own pace. A paused or slow consumer delays its work, but the booking itself is never blocked.

## Example
A buyer confirms a seat hold. In one transaction, the bookings and `launch_events.booking_confirmed` are written. The event then reaches the [`notification-router`](notification-router.md) [consumer group](consumer-group.md). The buyer gets one `booking.confirmed` inbox item. If the topic is [replayed](event-replay.md), inboxes and unread counts stay unchanged (J03 AS-02, AS-08).

## Known gaps
- The spec does not say which events besides `launch_events.booking_confirmed` travel on this topic, for example status changes to `SOLD_OUT`. The topic name and that event are listed separately in the facts. Their pairing follows the [`<aggregateType>.events` naming](aggregate-type-events-topic.md), but the facts do not state it outright.
- The spec does not say whether the voucher command to orders travels on this topic, and which consumer group (`notification-router` or `orders-booking-voucher`) reads it.
- Not confirmed in the code: the facts list no code symbols or topic definition for this topic.

## Used by
<!-- used-by:start -->
- [aggregate-type-events-topic](aggregate-type-events-topic.md)
- [consumer-group](consumer-group.md)
- [event-backbone](event-backbone.md)
- [event-replay](event-replay.md)
- [launch-event](launch-event.md)
- [outbox-append](outbox-append.md)
<!-- used-by:end -->
