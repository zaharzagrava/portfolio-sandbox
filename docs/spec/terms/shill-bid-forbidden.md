---
id: shill-bid-forbidden
title: shill_bid_forbidden (403)
kind: term
status: draft
aliases: [shill_bid_forbidden]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# shill_bid_forbidden (403)
## Definition
`shill_bid_forbidden` is the error a bid receives when the bidder is a [member of the shop](shop-member.md) that sells the [auctioned unit](auction-unit.md). The request is refused with status 403 and the bid is not recorded. Such a member also must never receive [the award](award-notice.md). Design intent (not stated in the spec): it stops a shop from raising its own auction price with fake bids.

## Example
A staff member of the selling shop places a bid on that shop's auction:
```
HTTP/1.1 403
{ "code": "shill_bid_forbidden" }
```
The current price and the [current leader](proxy-bidding.md) stay as they were.

## Known gaps
- The spec does not say whether membership is checked only at bid time or again at award time, for example for someone who joins the shop after bidding.
- The spec does not name the bid route or give the full [problem body](problem-body.md).

## Used by
<!-- used-by:start -->
- [auction-unit](auction-unit.md)
- [award-notice](award-notice.md)
- [problem-body](problem-body.md)
- [proxy-bidding](proxy-bidding.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
