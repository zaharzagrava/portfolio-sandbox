---
id: auction-leader
title: Auction leader
kind: term
status: draft
aliases: [leader, leads]
defined_for: J03-launch-day
rules_hash: 18656160b50c
---
# Auction leader
## Definition
The auction leader is the bidder who currently holds the top position in an auction. The position follows proxy bidding, so a new bid can replace the leader without the leader acting. When a bidder loses the lead, that bidder receives one [outbid notice](outbid-event.md). When the close job runs, the leader becomes the winner only if the leading bid is at or above the auction reserve. A leader the auction cannot award is a refused leader.

## Example
Bids of 10000, 5000 and 12000 arrive. The price follows proxy bidding, and the leader who is outbid is told once (J03.B-12). When the end passes with the leader at or above the reserve, the auction is `CLOSED`. The leader gets one winner order and one `auction.won` notice (J03.B-14). If that leader does not pay, the runner-up at or above the reserve may get a second chance (J03.B-16).

## Known gaps
- The spec does not say how a tie between equal bids decides the leader.
- The spec does not say how proxy bidding sets the price the leader pays. It only says the price follows proxy bidding.
- The spec does not say whether the leader can see their own maximum. FR-029 and FR-030 keep the maximum out of events, but this journey has no rule for them.

## Used by
<!-- used-by:start -->
- [auction-won-event](auction-won-event.md)
- [bid-increment](bid-increment.md)
- [close-job](close-job.md)
- [outbid-event](outbid-event.md)
- [proxy-bidding](proxy-bidding.md)
- [refused-leader](refused-leader.md)
<!-- used-by:end -->
