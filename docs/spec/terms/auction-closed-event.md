---
id: auction-closed-event
title: auction.closed event
kind: term
status: draft
aliases: [auction.closed]
defined_for: J03-launch-day
rules_hash: fd9fa0dd52c6
---
# auction.closed event
## Definition
`auction.closed` is the event recorded when an auction closes. Closing produces exactly one, even under [duplicate triggers](duplicate-triggers.md). Following the journey's decisions, it is appended in the [same transaction](active-transaction.md) as the state change, so a closed auction always has its event. The launch-day journey reads it, while the auctions domain owns it.

## Example
The leader is at or above the [reserve](auction-reserve.md) when the end passes. [`auctions.close`](auctions-close-job.md) moves the auction to `CLOSED` and appends one `auction.closed` (J03 AS-31). Downstream consumers then react to it.

## Known gaps
- The spec does not say which topic carries `auction.closed`. The page lists only `launch-events.events`, `orders.events` and `live.events`.
- The spec does not say what the payload holds, or whether an auction that ends [`UNSOLD(reserve_not_met)`](auction-unsold.md) also emits it.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [auction-reserve](auction-reserve.md)
- [award-notice](award-notice.md)
- [duplicate-triggers](duplicate-triggers.md)
<!-- used-by:end -->
