---
id: behavior
title: Behavior
kind: term
status: draft
aliases: [b-14, behaviors]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# Behavior
## Definition
A behavior is one numbered, concrete example of how a [capability](capability.md) acts, written as "Given … when … then …". Its id is made of the capability id, `B-` and a number. [Rules](rule-proof.md) state what must always hold. Behaviors show one specific flow, often with the exact status code or result. Each behavior cites the [acceptance scenarios](acceptance-scenario.md) that prove it in a `[[proof: ...]](rule-proof.md)` tag.

## Example
`S05.B-14`: given stock 5 and ten [concurrent ↗](../sw-external-terms.md#race-condition) `-1` operations, five apply, five give `[insufficient_stock](insufficient-stock.md)`, and stock ends at 0. It cites `[proof: S05 AS-53]`, the same scenario that rule `S05.R-19` cites.

## Known gaps
- The spec does not say which rule each behavior illustrates. You find the link only through a shared scenario id, as with `S05.B-14` and `S05.R-19` both citing AS-53.
- The spec does not say whether a value that appears only in a behavior is binding. One example is the 2 s database answer in `S05.B-11`, which no rule states.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [basket-type-parameter](basket-type-parameter.md)
- [capability](capability.md)
- [rule-proof](rule-proof.md)
- [time-to-full](time-to-full.md)
- [visitor](visitor.md)
<!-- used-by:end -->
