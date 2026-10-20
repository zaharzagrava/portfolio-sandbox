---
id: bid-increment
title: Bid increment
kind: term
status: draft
aliases: [increment]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# Bid increment
## Definition
A bid increment is the step by which an auction price rises when a new bid comes in. In the usual model of [proxy bidding](proxy-bidding.md), the [leader](auction-leader.md)'s price goes up to the next-highest maximum plus one increment, never to the leader's full maximum. A new bid usually has to beat the current price by at least one increment. The facts never name this value for this system, so treat it as the general auction concept, not a confirmed setting.

## Example
Bids of 10000, 5000 and 12000 arrive in that order (J03.B-12). The 12000 bid takes the lead and the earlier leader receives one [outbid notice](outbid-event.md). With an illustrative increment of 100, proxy bidding would show 10100, not 12000. The spec does not confirm the 100 or the 10100.

## [Known gaps](known-gaps.md)
- The spec does not say whether the auction uses a bid increment, or what its value or scale is.
- The spec does not say what happens to a bid that is above the current price but below the price plus an increment, including which error it gets.
- The spec does not say whether bid amounts and increments are in [minor units](minor-units.md).

## Used by
<!-- used-by:start -->
- [auction-leader](auction-leader.md)
- [known-gaps](known-gaps.md)
- [minor-units](minor-units.md)
- [outbid-event](outbid-event.md)
- [proxy-bidding](proxy-bidding.md)
<!-- used-by:end -->
