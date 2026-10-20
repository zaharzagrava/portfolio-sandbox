---
id: booking-confirmed-notification
title: booking.confirmed notification
kind: term
status: draft
aliases: [booking.confirmed]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# booking.confirmed notification
## Definition
The `booking.confirmed` notification is the [inbox item](inbox-item.md) a buyer gets after confirming a [seat hold](seat-hold.md). The [`notification-router` consumer group](notification-router.md) creates it from the [`launch_events.booking_confirmed` event](launch-events-booking-confirmed-event.md), never from the booking request itself. As a result, a paused or failing notification consumer delays the notice but never blocks the booking. Each confirmed booking produces exactly one such item, even when confirms are retried or the [topic is replayed](event-replay.md).

## Example
A buyer confirms a hold while the notification consumer is paused. The booking exists at once. After the consumer is resumed, the buyer's inbox holds one `booking.confirmed` item, and orders has created one voucher (J03.B-02, J03.B-06).

## Known gaps
- The spec does not say what the item contains, such as event name, seats or voucher reference.
- The spec does not say whether this notification type is mandatory or which channels besides the inbox it uses.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
