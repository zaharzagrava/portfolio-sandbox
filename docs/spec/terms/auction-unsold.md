---
id: auction-unsold
title: UNSOLD auction outcome
kind: term
status: draft
aliases: [unsold, unsold auctions]
defined_for: J03-launch-day
rules_hash: f6e61e7db675
---
# UNSOLD auction outcome
## Definition
`UNSOLD` is an end state of an auction in which nothing is sold. When the leader's bid is below the [reserve](auction-reserve.md), the auction ends as `UNSOLD(reserve_not_met)`. In that case no [winner order](winner-order.md) is created, no [award notice](award-notice.md) is sent, and [the unit is returned](auction-unit.md). An unpaid winner order can also lead to `UNSOLD` instead of a [second chance](second-chance.md). An unsold auction produces no [inbox item](inbox-item.md), by decision.

## Example
An auction has a reserve of 15000 and the highest bid is 12000 (both illustrative). The [`auctions.close`](auctions-close-job.md) job runs and the auction ends as `UNSOLD(reserve_not_met)`. No order exists, nobody receives [`auction.won`](auction-won-notice.md), and the unit goes back to the shop.

## Known gaps
- The spec does not say whether a reserve-not-met auction passes through [`CLOSED`](auction-status.md) first; the lifecycle lists `CLOSED` and then `UNSOLD`.
- The spec does not say which reason code an `UNSOLD` auction carries when it ends after an unpaid winner order.
- The spec does not say how "the unit returned" is carried out, for example which stock command or event is used.

## Used by
<!-- used-by:start -->
- [auction-reserve](auction-reserve.md)
- [auction-unit](auction-unit.md)
- [award-notice](award-notice.md)
- [inbox-item](inbox-item.md)
- [no-notification-list](no-notification-list.md)
- [second-chance](second-chance.md)
- [winner-order](winner-order.md)
<!-- used-by:end -->
