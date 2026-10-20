---
id: launch-event
title: Launch event
kind: term
status: draft
aliases: [launch events]
defined_for: J03-launch-day
rules_hash: 36ece1d040da
---
# Launch event
## Definition
A launch event is a seated event that a brand runs on launch day. Buyers join its buyer queue, and the admitter gives each admitted buyer an admission token bound to this event. With that token a buyer places a hold on seats and then confirms it into a booking set. Its launch event status shows whether seats can be sold; the sales-time job, the last booking and the [organizer](organizer.md) move that status. Each confirmed booking emits `launch_events.booking_confirmed` on the [`launch-events.events` topic](launch-events-events-topic.md), along with a voucher command to orders.

## Example
Twelve buyers wait in the queue of one launch event while sales are open. The admitter runs, and each buyer gets an admission token for that event. Each buyer holds seats and confirms the hold. Each confirm writes the bookings, `launch_events.booking_confirmed` and the voucher command in one transaction (J03 AS-01, AS-02).

## Known gaps
- The spec does not say what a launch event holds, such as its seat count, sales time or owning shop, or how a brand creates one.
- The spec does not say who the organizer is, for example which shop role may close an event.
- Not confirmed in the code: the facts list no routes or code symbols for launch events. The only confirmed file is the journey test `launch-day.journey-spec.ts`.

## Used by
<!-- used-by:start -->
- [admission-token](admission-token.md)
- [admitter](admitter.md)
- [buyer-queue](buyer-queue.md)
- [launch-event-status](launch-event-status.md)
- [launch-events-events-topic](launch-events-events-topic.md)
- [organizer](organizer.md)
- [reservation-hold](reservation-hold.md)
- [seat-hold](seat-hold.md)
- [sold-out](sold-out.md)
<!-- used-by:end -->
