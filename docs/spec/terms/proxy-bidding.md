---
id: proxy-bidding
title: Proxy bidding
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 416a5ef8acb8
---
# Proxy bidding
## Definition
Proxy bidding is how the auction sets its current price from the bids it receives. In the usual model, each bid is a bidder's maximum. The system raises the price for the [leader](auction-leader.md) only as far as needed to beat the next-highest maximum. When a new bid takes the lead, the previous leader receives one [outbid notice](outbid-event.md).

## Example
Bids of 10000, 5000 and 12000 arrive in that order. The 5000 bid does not take the lead. The 12000 bid does, so the first bidder becomes the outbid leader and is told once. The current price follows proxy bidding rather than jumping to 12000.

## Known gaps
- The spec does not say the [bid increment](bid-increment.md) or the exact price the auction shows after each bid.
- The spec does not say how two equal maximum bids are ordered.
- The spec does not say whether bid amounts are in [minor units](minor-units.md).

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-12
- [auction-leader](auction-leader.md)
- [bid-increment](bid-increment.md)
- [minor-units](minor-units.md)
- [outbid-event](outbid-event.md)
- [shill-bid-forbidden](shill-bid-forbidden.md)
<!-- used-by:end -->
