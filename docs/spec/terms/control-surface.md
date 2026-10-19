---
id: control-surface
title: Control surface
kind: term
status: draft
aliases: [test and local control surface]
defined_for: J03-launch-day
rules_hash: 57adbbbbdca0
---
# Control surface
## Definition
The control surface is a set of operations for tests and local use that drive the [launch-day stack](launch-day-flow.md) from outside. It offers [allow-listed jobs](job.md), [consumer pause](partition-pause.md), resume and [lag](consumer-lag.md), and a read-only [event tap](event-tap.md). Tests use it to make work run at a chosen moment, such as [`auctions.close`](auctions-close-job.md) or [`flash-sale.load`](flash-sale-load-job.md). They also use it to [hold](booking-hold.md) a consumer back and check that nothing is lost after resume. Design intent (not stated in the spec): tests can control timing and outages without changing production code paths.

## Example
`launch-day.journey-spec.ts` pauses the `notification-router` consumer, and then a buyer confirms a hold. The booking exists at once and the consumer lag is visible. After resume, the buyer gets one `booking.confirmed` item (J03.B-06).

## Known gaps
- The spec does not say which routes or paths expose the control surface. Tests G-40, G-41 and G-42 cover admin job, topic and consumer endpoints, but their paths are not in the facts.
- The spec does not say which jobs are on the allow-list.
- The spec does not say how the control surface is kept out of production, beyond "test and local use".

## Used by
<!-- used-by:start -->
- [stack](stack.md)
<!-- used-by:end -->
