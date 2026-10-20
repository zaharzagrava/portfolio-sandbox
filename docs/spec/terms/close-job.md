---
id: close-job
title: Close job
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: d3a9295f318e
---
# Close job
## Definition
The close job is the scheduled job [`auctions.close`](auctions-close-job.md), which ends an auction once its `endsAt` has passed. Closing is one [conditional transition](conditional-transition.md), so duplicate triggers are safe. A successful close produces one `auction.closed` event, one winner order and one `auction.won` notice. If the [leader](auction-leader.md) is below the reserve, the auction ends `UNSOLD(reserve_not_met)` with no order and no award notice, and [the unit is returned](auction-unit.md).

## Example
An auction's leader is at or above the reserve. `auctions.close` fires twice for the same end. The auction becomes `CLOSED` once, with one `auction.closed`, one winner order and one `auction.won` notice.

## Known gaps
- Not confirmed in the code: the condition the close job checks, for example whether it compares the stored `endsAt` to its own due time.
- The spec does not say how the close job is scheduled again after `endsAt` moves.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-13
- [anti-sniping-window](anti-sniping-window.md)
- [auction-leader](auction-leader.md)
- [auction-status](auction-status.md)
- [auction-unit](auction-unit.md)
- [conditional-transition](conditional-transition.md)
- [duplicate-triggers](duplicate-triggers.md)
- [ends-at](ends-at.md)
<!-- used-by:end -->
