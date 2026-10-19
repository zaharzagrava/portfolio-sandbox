---
id: event-tap
title: Event tap
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: cbc4345b8573
---
# Event tap
## Definition
The event tap is the read-only part of the control surface that lets a test see the events published on the stack. A test reads it to check that a [fact](fact.md) produced its event, for example once and with the expected type. Reading the tap does not consume or change events, so it does not affect any [consumer group](consumer-group.md). Design intent (not stated in the spec): it lets tests assert hand-offs without joining a real consumer group or touching [offsets ↗](../sw-external-terms.md#kafka-offset-commit).

## Example
After [`auctions.close`](auctions-close-job.md) runs twice for the same auction, a test reads the tap. It expects exactly one [`auction.closed`](auction-closed-event.md) event for that auction (J03.R-10).

## Known gaps
- The spec does not say how the tap is reached (route, stream or query) or what it returns.
- The spec does not say which topics the tap covers, for example whether it includes `launch-events.events`, `orders.events` and `live.events`.
- The spec does not say whether the tap shows events as published to the broker or as rows still in the [outbox](inbox-table.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
