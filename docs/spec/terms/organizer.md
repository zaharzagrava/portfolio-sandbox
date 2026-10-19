---
id: organizer
title: Organizer
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: d6c329ad5b1d
---
# Organizer
## Definition
The organizer is the person on the brand's side who runs a launch event. Along with the [sales-time job](job.md) and the last booking, the organizer is one of the three things that can change the launch event status. The organizer's change is manual, while the other two happen automatically. The [last seat](seat.md) moves the event to `SOLD_OUT`. That suggests, but does not confirm, that the organizer's role is closing the event.

## Example
Illustrative: a launch event is `ON_SALE` with seats still free. The organizer ends the sale early, and the event becomes `CLOSED`. Buyers can no longer hold seats. (The transition is illustrative; the facts do not name it.)

## Known gaps
- The spec does not say who counts as the organizer, for example which [shop role](shop-role.md). It also does not say how the organizer is checked.
- The spec does not say which status transition the organizer triggers. `CLOSED` is an inference from the lifecycle, not a stated rule.
- Not confirmed in the code: the facts list no route or code symbol for organizer actions.

## Used by
<!-- used-by:start -->
- [launch-event](launch-event.md)
<!-- used-by:end -->
