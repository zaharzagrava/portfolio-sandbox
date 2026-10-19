---
id: launch-events-booking-confirmed-event
title: launch_events.booking_confirmed event
kind: term
status: draft
aliases: [launch_events.booking_confirmed]
defined_for: J03-launch-day
rules_hash: 321a243bcadd
---
# launch_events.booking_confirmed event
## Definition
This is the event that records that a buyer's [hold](booking-hold.md) was confirmed into [bookings](booking-set.md). It is written in the same transaction as the bookings and [the voucher command](voucher-command.md). No network call happens inside that transaction, so no booking exists without its event. Consumers read it from the [`launch-events.events` topic](aggregate-type-events-topic.md). The [notification router](notification-router.md) turns it into the buyer's `booking.confirmed` [inbox item](inbox-item.md).

## Example
A buyer confirms a hold. Once the event reaches notifications and orders, the buyer has exactly one `booking.confirmed` item and one voucher (J03 AS-02). If the `notification-router` consumer is paused, the booking exists at once and the notice arrives after resume (J03 AS-06).

## Known gaps
- The spec does not list the event's [payload members](event-payload.md).
- The spec does not say which [consumer groups](consumer-group.md) besides `notification-router` read this event. `orders-booking-voucher` is listed, but its input is not stated.
- The spec does not say whether this event or a separate message carries the voucher command to orders.

## Used by
<!-- used-by:start -->
- [booking-confirmed-notification](booking-confirmed-notification.md)
<!-- used-by:end -->
