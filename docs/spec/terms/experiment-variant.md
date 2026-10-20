---
id: experiment-variant
title: Experiment variant
kind: term
status: draft
aliases: [variants]
defined_for: J05-engagement-loop
rules_hash: e43a56edc872
---
# Experiment variant
## Definition
A variant is one of the alternatives an experiment compares, as in A/B. Each exposure belongs to one variant, and so does each [conversion](conversion.md) that follows it. The experiment's results are exposure and conversion counts per variant. [Replaying events](event-replay.md) must not change those counts.

## Example
Exposures and conversions per variant (illustrative values):
```json
{ "A": { "exposures": 120, "conversions": 9 }, "B": { "exposures": 118, "conversions": 14 } }
```
After the operator replays [`orders.events`](orders-events-topic.md), both rows stay exactly the same.

## Known gaps
- The spec does not say how a buyer is assigned to a variant, or whether the assignment is sticky.
- The spec does not say the shape or route of the per-variant results.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
