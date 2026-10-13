---
id: trending-configuration
title: TRENDING_* configuration
kind: term
status: draft
aliases: [trending_*]
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# TRENDING_* configuration
## Definition
The `TRENDING_*` variables are the settings that tune the [trending capability](capability.md). They set the [event weights](trending-event-weight.md), the [window length](trending-window.md), the [allowed lateness](allowed-lateness.md) and the [idle-partition timeout](idle-timeout.md). They also set the heap size, the sketch depth, the category cap, the memory budget and the time budgets for dependencies. The default values are in `TRENDING_DEFAULTS`. The capability owns this configuration.

## Example
Defaults from `packages/backend/libs/domains/discovery/domain/trending-config.ts#TRENDING_DEFAULTS`:
```
weights: view 1, add-to-cart 5    window: 60 s    lateness: 120 s    idle: 30 s
heap K: 50    depth: 4    category cap: 100    memory budget: 512 MB
budgets: 100 / 100 / 50 / 100 ms
```

## Known gaps
- The spec does not give the name of each variable. It also does not say which dependency each of the four budgets applies to. Only the product lookup (100 ms) and the shop lookup (50 ms) are named, in S35.R-13.
- Not confirmed end to end: whether startup fails on an invalid value. Configuration validation (AS-37) is covered by a unit spec only.
- The spec does not say what happens when the memory budget is exceeded.

## Used by
<!-- used-by:start -->
- [allowed-lateness](allowed-lateness.md)
- [bounded-retention](bounded-retention.md)
- [capability](capability.md)
- [idle-timeout](idle-timeout.md)
- [sketch-overcount](sketch-overcount.md)
- [top-k-heap](top-k-heap.md)
- [trending-event-weight](trending-event-weight.md)
- [trending-window](trending-window.md)
- [window-minutes](window-minutes.md)
<!-- used-by:end -->
