---
id: voucher-command
title: Voucher command
kind: term
status: draft
aliases: [voucher]
defined_for: J03-launch-day
rules_hash: 74bd3d8c5e0e
---
# Voucher command
## Definition
The [voucher](voucher.md) command is the instruction sent to the [orders domain](orders-domain.md) to issue a voucher for a confirmed [booking](booking-set.md). It is written in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the bookings and `launch_events.booking_confirmed`, so it is never lost. Orders applies it asynchronously, so a paused [voucher consumer](event-consumer.md) delays the voucher but never blocks the booking. [Replaying](event-replay.md) it must leave vouchers unchanged.

## Example
A buyer confirms a [hold](booking-hold.md) while the voucher consumer is paused. The booking exists at once. The buyer's single voucher appears only after the consumer resumes (J03 AS-07).

## Known gaps
- The spec does not say what a voucher is in the orders domain, for example an order, a code or a document.
- The spec does not give the command's name, payload or the topic or queue that carries it.
- Not confirmed in the code: that the [`orders-booking-voucher` consumer group](consumer-group.md) is the one that applies it.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-01, R-04
- [booking-hold](booking-hold.md)
- [launch-events-booking-confirmed-event](launch-events-booking-confirmed-event.md)
<!-- used-by:end -->
