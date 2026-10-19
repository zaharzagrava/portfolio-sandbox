---
id: auctions-close-job
title: auctions.close job
kind: term
status: draft
aliases: [auctions.close]
defined_for: J03-launch-day
rules_hash: 1ebeb2b97580
---
# auctions.close job
## Definition
`auctions.close` is the job that ends an auction once its [`endsAt`](ends-at.md) has passed on the [injected clock](injected-clock.md). It performs the close as one [conditional transition](conditional-transition.md), so [duplicate triggers](duplicate-triggers.md) produce one [`auction.closed`](auction-closed-event.md), one [winner order](winner-order.md) and one [`auction.won` notice](auction-won-notice.md). If the leader is below the [auction reserve](auction-reserve.md), the auction ends as [`UNSOLD(reserve_not_met)`](auction-unsold.md) instead, and the unit is returned. If a bid inside the [anti-sniping window](anti-sniping-window.md) moved `endsAt` later, the original close job does nothing. After the close, order events move the auction on to `SOLD`, [`SECOND_CHANCE`](second-chance.md) or `UNSOLD`, not this job.

## Example
A leader bids 12000 against a reserve of 10000 (illustrative reserve). When the end passes, `auctions.close` moves the auction to `CLOSED`. The winner gets one winner order and one `auction.won` notice. A duplicate run of the same job changes nothing.

## Known gaps
- The spec does not say whether a new close job is scheduled when an anti-sniping bid moves `endsAt`, or how the later end is picked up.
- The spec does not say how the close job handles a leader who is a member of the selling shop. It only says that member must not receive the award and that a refused leader produces no inbox item.
- Not confirmed in the code: how the job is enqueued per auction, for example its enqueue key or payload.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
