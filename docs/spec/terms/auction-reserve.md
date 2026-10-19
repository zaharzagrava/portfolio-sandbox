---
id: auction-reserve
title: Auction reserve
kind: term
status: draft
aliases: [reserve price]
defined_for: J03-launch-day
rules_hash: e05ab30ca467
---
# Auction reserve
## Definition
The reserve is the lowest price at which the selling shop agrees to sell the auctioned unit. When the auction ends, a leader below the reserve does not win. The auction then ends [`UNSOLD(reserve_not_met)`](auction-unsold.md), with no order, no [award notice](award-notice.md) and the unit returned. The reserve also limits the [second chance](second-chance.md), which goes only to a [runner-up](runner-up-offer.md) at or above it.

## Example
The reserve is 10000 (illustrative), and the highest bid when the end passes is 8000 (illustrative). The auction ends `UNSOLD(reserve_not_met)`, no winner order is created and no [inbox item](inbox-item.md) appears (J03 AS-35).

## Known gaps
- The spec does not say who sets the reserve or when, or whether bidders can see it.
- The spec does not say whether a leader exactly at the reserve wins. J03.B-14 says "at or above", which suggests they do.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
