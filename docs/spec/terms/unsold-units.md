---
id: unsold-units
title: Unsold units
kind: term
status: draft
aliases: [units, unsold]
defined_for: J03-launch-day
rules_hash: 52a145749c3e
---
# Unsold units
## Definition
Unsold units are the units of a [drop](drop.md) that no buyer has paid for when the drop closes. `flash-sale.end` and `flash-sale.reconcile` return them to [catalog stock](catalog-stock.md), and only once. Paid units are never part of this set: they stay sold. Units from a lapsed [drop hold](drop-hold.md) come back separately, through [`orders.expire-reservation`](orders-expire-reservation-job.md).

## Example
From J03.B-07: a drop loads 20 units and all 20 are reserved. Illustrative: 15 of those reservations lapse and are released by `orders.expire-reservation`, and 5 are paid. Nothing is left as unsold units at end, so the end and reconcile jobs return nothing.

## Known gaps
- The spec does not say whether a reservation that is still unpaid at end time counts as unsold.
- The spec does not give the exact calculation, for example loaded units minus paid units.
- Do not confuse this with an unsold auction: J03.R-11 also mentions "the unit returned", but the spec does not say where an auction unit goes back to.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
