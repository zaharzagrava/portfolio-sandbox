---
id: no-notification-list
title: No-notification list
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# No-notification list
## Definition
The no-notification list is the set of facts that, by decision, never produce an [inbox item](inbox-item.md). Rule J03.R-16 names them: stream start and end, comments, [holds and expiries](booking-hold.md), [unsold auctions](auction-unsold.md), and a [refused leader](refused-leader.md). The [`notification-router`](notification-router.md) consumer must leave the buyer's and the brand's inbox untouched when these events arrive. This keeps inboxes limited to the steps that matter to a buyer or the brand. That reason is design intent (not stated in the spec).

## Example
A buyer holds a seat and never confirms it. The hold expires and the seat is free again, but the buyer gets no inbox item for the expiry. An auction that ends `UNSOLD(reserve_not_met)` also produces no [award notice](award-notice.md) and no inbox item.

## Known gaps
- The spec does not say whether stream pins and comment removals belong to the list. J03.R-16 does not name them.
- The spec does not say how "holds and expiries" relates to [drop hold](drop-hold.md)s. J03.R-08 says a lapsed drop hold must notify the buyer, so the list appears to cover seat holds only.
- Not confirmed in the code: where the list is enforced. It could be enforced in the notification router, in the [notification catalog](notification-catalog.md) or in each event type.

## Used by
<!-- used-by:start -->
- [auction-unsold](auction-unsold.md)
- [award-notice](award-notice.md)
- [booking-hold](booking-hold.md)
- [drop-hold](drop-hold.md)
- [inbox-item](inbox-item.md)
- [notification-catalog](notification-catalog.md)
- [refused-leader](refused-leader.md)
- [stream-pin](stream-pin.md)
<!-- used-by:end -->
