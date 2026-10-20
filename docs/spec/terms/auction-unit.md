---
id: auction-unit
title: Auction unit
kind: term
status: draft
aliases: [unit, units]
defined_for: J03-launch-day
rules_hash: 8692898bc208
---
# Auction unit
## Definition
An auction unit is the single item of stock that an auction sells. The auction closes with one winner, and that winner's [settlement order](order-settlement.md) pays for the unit. If the auction ends as `UNSOLD`, for example `UNSOLD([reserve](auction-reserve.md)_not_met)`, the unit is returned. Under flow isolation, an auction unit belongs to one flow only, and no other flow's bids or checkouts can touch it.

## Example
An auction with a leader below the reserve closes. It ends as `UNSOLD(reserve_not_met)`, no order or [`auction.won` notice](auction-won-notice.md) is created, and the unit is returned.

## Known gaps
- The spec does not say where the returned unit goes, for example back to catalog product stock.
- The spec does not say when the unit is taken out of stock, such as when the auction is created or when it closes.
- The spec does not say whether "units" in J03.R-20 means auction units only or also flash-sale drop units.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-20
- [auction-unsold](auction-unsold.md)
- [auction-won-notice](auction-won-notice.md)
- [catalog-stock](catalog-stock.md)
- [close-job](close-job.md)
- [drop-hold](drop-hold.md)
- [flash-sale-sold-out-notification](flash-sale-sold-out-notification.md)
- [flow-isolation](flow-isolation.md)
- [order-settlement](order-settlement.md)
- [shill-bid-forbidden](shill-bid-forbidden.md)
<!-- used-by:end -->
