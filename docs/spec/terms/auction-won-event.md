---
id: auction-won-event
title: auction.won notice
kind: term
status: draft
aliases: [auction.won]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# auction.won notice
## Definition
The [`auction.won` notice](auction-won-notice.md) is the notification that tells a buyer they won an auction. It appears when the [`auctions.close` job](auctions-close-job.md) closes an auction whose [leader](auction-leader.md) is at or above the [reserve](auction-reserve.md). The close also produces [`auction.closed`](auction-closed-event.md) and the winner's [settlement order](winner-order.md). Duplicate close triggers must not produce a second notice. A leader below the reserve, or a member of the selling shop, never receives it.

## Example
Bids of 10000, 5000 and 12000 are placed. The end passes and the leader is at or above the reserve. The auction becomes `CLOSED`, and the winner's inbox gains one `auction.won` item next to their winner order.

## Known gaps
- The spec does not say which domain emits `auction.won`, or what its payload holds.
- The spec does not say whether a runner-up who receives the second chance also gets an `auction.won` notice.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
