---
id: payout-paid-event
title: payout.paid event
kind: term
status: draft
aliases: [payout.paid]
defined_for: J01-buy-to-payout
rules_hash: e3b0c44298fc
---
# payout.paid event
## Definition
The event that says a payout to a shop was transferred successfully. It travels on the [event backbone](event-backbone.md) through the [outbox task queue](task-row.md), like the other events of the [journey chain](main-journeys.md). The notifications side consumes it and sends one `payout.paid` [notice](notification.md) to the shop's owners. A re-run of the payout run does not produce a second event or a second notice.

## Example
For a shop with a balance above the [payout minimum](payout-minimum.md) and a [destination](payout-destination.md) set, the operator runs [`payouts.run-weekly`](payouts-run-weekly-job.md). One payout is paid, `payout.paid` is published, and the owner holds one `payout.paid` notice.

## Known gaps
- The spec does not say which topic carries `payout.paid` or which members its payload has.

## Used by
<!-- used-by:start -->
- [event-backbone](event-backbone.md)
- [main-journeys](main-journeys.md)
- [notification](notification.md)
- [payout-destination](payout-destination.md)
- [payout-minimum](payout-minimum.md)
- [payouts-domain](payouts-domain.md)
- [task-row](task-row.md)
<!-- used-by:end -->
