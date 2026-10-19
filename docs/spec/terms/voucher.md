---
id: voucher
title: Voucher
kind: term
status: draft
aliases: [vouchers]
defined_for: J03-launch-day
rules_hash: fdd19c3e9c79
---
# Voucher
## Definition
A voucher is the item orders creates for a buyer when their [seat booking](seat-hold.md) is confirmed. Confirming a [hold](booking-hold.md) writes a voucher command to orders [in the same transaction ↗](../sw-external-terms.md#database-transaction) as the bookings and `launch_events.booking_confirmed`. The [`orders-booking-voucher` consumer group](consumer-group.md) then creates the voucher. Each confirmed [booking set](booking-set.md) yields exactly one voucher, even under retries, replays or a paused consumer. If that consumer is paused, the booking still exists at once and the voucher appears after resume.

## Example
A buyer holds seats with their [admission token](admission-token.md) and confirms the hold. They end up with one `booking.confirmed` [inbox item](inbox-item.md) and one voucher. Replaying [`launch-events.events`](aggregate-type-events-topic.md) leaves them with still one voucher.

## Known gaps
- The spec does not say what a voucher contains or how the buyer uses it. Design intent (not stated in the spec): it proves the booking at the event.
- The spec does not name the voucher command, the voucher's table, or any route that reads it.
- The spec does not say whether an expired or cancelled booking affects an existing voucher.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
