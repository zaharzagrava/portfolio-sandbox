---
id: acceptance-scenario
title: Acceptance scenario
kind: term
status: draft
aliases: [as-10, scenario, scenario id]
defined_for: S05-products
rules_hash: 64c6dc189576
---
# Acceptance scenario
## Definition
An acceptance scenario is one concrete, checkable case in a [capability](capability.md)'s specification that shows a rule or behavior holds. Each has an id made of the capability and a scenario number. Rules and behaviors cite these ids in their [`[proof: ...]`](rule-proof.md) tags. Tests carry the same ids, so you can go from a rule to the tests that check it. The capability page shows only the ids; the full scenario text lives in the specification.

## Example
Behavior [`S05.B-14`](behavior.md) cites `[proof: S05 AS-53]`: with stock 5 and ten [concurrent `-1` operations](stock-operation.md), five apply, five give [`insufficient_stock`](insufficient-stock.md), and stock ends at 0. To check it, find the test that carries `AS-53`.

## Known gaps
- The spec does not say that every scenario has a test. The S05 ["Known gaps" section](known-gaps.md) lists ids that no test carries, such as AS-33, AS-67 to AS-79 and AS-81.
- The spec does not say how a test carries a scenario id, for example in the test name or in a tag.
- The spec does not say where the full scenario text is stored. The capability page gives only the ids, so you cannot read the exact setup and expected result there.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-01
- [amount-out-of-range](amount-out-of-range.md)
- [baseline-frame](baseline-frame.md)
- [behavior](behavior.md)
- [cache-invalidator](cache-invalidator.md)
- [capability](capability.md)
- [cart-badge-display-ceiling](cart-badge-display-ceiling.md)
- [dataset-t](dataset-t.md)
- [delivery-timeline](delivery-timeline.md)
- [exact-top-k](exact-top-k.md)
- [get-payments](get-payments.md)
- [hot-key](hot-key.md)
- [in-process-port](in-process-port.md)
- [injected-clock](injected-clock.md)
- [known-gaps](known-gaps.md)
- [popularity-floor](popularity-floor.md)
- [queue-refusal](queue-refusal.md)
- [reset-on-success](reset-on-success.md)
- [resumable-fan-out](resumable-fan-out.md)
- [robots-list](robots-list.md)
- [rule-proof](rule-proof.md)
- [seeded-stream](seeded-stream.md)
- [shop-search-table](shop-search-table.md)
- [stock-operation](stock-operation.md)
<!-- used-by:end -->
