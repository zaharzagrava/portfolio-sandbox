---
id: refused-leader
title: Refused leader
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 16227ffd77f2
---
# Refused leader
## Definition
A refused leader is a bidder who [leads an auction](auction-leader.md) but is not given [the award](award-notice.md). The facts list two ways this happens. The leader's bid may be below [the reserve](auction-reserve.md), so the auction ends as [`UNSOLD(reserve_not_met)`](auction-unsold.md). Or the leader may be a member of the selling shop, who must not receive the award. A refused leader gets no [inbox item](inbox-item.md), by decision.

## Example
An auction closes with a leader below the reserve. The auction ends `UNSOLD(reserve_not_met)`, no [winner order](winner-order.md) is created, the unit is returned, and no [`auction.won` notice](auction-won-notice.md) is sent (J03.R-11, J03.R-16).

## Known gaps
- The spec does not define "refused leader" directly. This page infers its meaning from the proofs J03 AS-29 (shill bid) and J03 AS-35 (reserve not met).
- The spec does not say whether the [runner-up](runner-up-offer.md) becomes the leader, or whether a [second chance](second-chance.md) follows, once a shop member is refused.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-16
- [auction-leader](auction-leader.md)
- [auction-reserve](auction-reserve.md)
- [auction-won-notice](auction-won-notice.md)
- [award-notice](award-notice.md)
- [inbox-item](inbox-item.md)
- [no-notification-list](no-notification-list.md)
- [runner-up-offer](runner-up-offer.md)
- [second-chance](second-chance.md)
- [winner-order](winner-order.md)
<!-- used-by:end -->
