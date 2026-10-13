---
id: recommendations-build-skipped-total
title: recommendations_build_skipped_total
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# recommendations_build_skipped_total
## Definition
`recommendations_build_skipped_total` is a [counter metric ↗](../sw-external-terms.md#counter-metric) owned by the [bought-together capability](bought-together.md). It is defined in `recommendations-metrics.ts`. Its name suggests it counts builds that ended in a skipped state instead of publishing lists, such as [`skipped_empty`](build-end-states.md) or [`skipped_locked`](skipped-locked.md). The spec lists only the metric's name, not what it counts. Use it to see how often the nightly build did no work.

## Example
Illustrative, and it assumes the counter covers skipped builds: the window has no [eligible baskets](basket.md), so the nightly build ends `skipped_empty` and the counter goes up by 1.
```
recommendations_build_skipped_total 1   # illustrative value
```

## Known gaps
- The spec does not say which build end states increase this counter: `skipped_empty`, `skipped_locked`, or both.
- The spec does not say whether the counter has a label (for example a reason label) that tells the skip states apart.
- Not confirmed in the code: the facts give only the file name `recommendations-metrics.ts`, with no full path or `[code]` link for this metric.

## Used by
<!-- used-by:start -->
- [basket](basket.md)
- [bought-together](bought-together.md)
<!-- used-by:end -->
