---
id: flow-isolation
title: Flow isolation
kind: term
status: draft
aliases: [flow, stack]
defined_for: J03-launch-day
rules_hash: dbc7224f0da8
---
# Flow isolation
## Definition
Flow isolation is the rule that several [launch-day flows](launch-day-flow.md) running at the same time on [one stack](stack.md) never affect each other. The [seats](seat.md), [units](auction-unit.md), comments and bids of one flow must never alter those of another. It applies across seat booking, [flash-sale drops](drop.md), live streams and auctions. Design intent (not stated in the spec): the journey test can then run many flows in parallel against one shared environment and still check exact counts.

## Example
Two auctions and one drop run at once in `launch-day.journey-spec.ts`. A bid on auction A never changes the price of auction B. A checkout on the drop never takes a unit from either auction.

## Known gaps
- The spec does not say how a flow is scoped, for example whether each flow uses its own shop, product, launch event or buyer accounts.
- The spec does not say what "one stack" covers, such as one database, one broker, or one deployed environment.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-20
<!-- used-by:end -->
