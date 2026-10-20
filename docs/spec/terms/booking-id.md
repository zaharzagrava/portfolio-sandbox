---
id: booking-id
title: bookingId
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: d55492e673da
---
# bookingId
## Definition
`bookingId` is the identifier of one booking in a booking set, and each [held seat](seat-hold.md) gets one booking. A booking confirm returns the `bookingId`s of the set it created. Every later or simultaneous confirm of the same hold returns those same ids, whatever [key](idempotency-key.md) it carries. A client can therefore treat matching ids as proof that it is looking at one booking set, not a duplicate.

## Example
A buyer confirms one hold five times at once with one key, and ten more times with other keys. Every answer carries the same `bookingId`s (J03 AS-03).

## Known gaps
- The spec does not give the format of a `bookingId`, or say whether any route looks up a booking by it.

## Used by
<!-- used-by:start -->
- [booking-confirm](booking-confirm.md)
- [seat-hold](seat-hold.md)
<!-- used-by:end -->
