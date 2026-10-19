---
id: auction-won-notice
title: auction.won notice
kind: term
status: draft
aliases: [auction.won]
defined_for: J03-launch-day
rules_hash: 6c2f4f804ef5
---
# auction.won notice
## Definition
`auction.won` is the notification type that tells the winning bidder they won an auction. Closing an auction leads to exactly one such notice, even under [duplicate triggers](duplicate-triggers.md). Like all notifications in this journey, it derives from events, so a [paused consumer](event-consumer.md) delays it but never blocks the award. A member of the selling shop never receives it, and an auction that ends below the [reserve](auction-reserve.md) produces none.

## Example
The leader is at or above the reserve when the end passes. The auction becomes [`CLOSED`](auction-status.md), and the winner finds one `auction.won` item in their [inbox](inbox-item.md) (J03 AS-31). [Replaying the topic](event-replay.md) leaves that inbox unchanged.

## Known gaps
- The spec does not say which event the [`notification-router`](notification-router.md) turns into `auction.won`. [`auction.closed`](auction-closed-event.md) is likely, but it is not confirmed.
- The spec does not say whether a runner-up given a [second chance](second-chance.md) receives an `auction.won` notice or a different notice.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
