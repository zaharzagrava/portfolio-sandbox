---
id: award-notice
title: Award notice
kind: term
status: draft
aliases: [award]
defined_for: J03-launch-day
rules_hash: 815d655e4a9e
---
# Award notice
## Definition
The award notice is the `auction.won` notification that tells the winner they won an auction. Closing an auction produces exactly one award notice, together with one [`auction.closed` event](auction-closed-event.md) and one winner order. An auction that ends `UNSOLD(reserve_not_met)` sends no award notice. A member of the [selling shop](shop-tenant.md) never receives the award. Like every notice, it comes from events through the [`notification-router` consumer group](consumer-group.md), so [duplicate triggers](duplicate-triggers.md) or replays must not create a second one.

## Example
The leader is at or above the reserve when the end passes. The auction becomes `CLOSED`, and the winner's inbox gains exactly one `auction.won` item next to their settlement order.

## Known gaps
- The spec does not explicitly state that "award notice" and the `auction.won` notice are the same thing; this page infers it from J03.R-10 and J03.B-14.
- The spec does not say which event the router turns into the award notice. `auction.closed` is the likely source but is not confirmed.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
