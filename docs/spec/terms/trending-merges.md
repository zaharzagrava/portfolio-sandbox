---
id: trending-merges
title: trendingMerges
kind: term
status: draft
aliases: []
defined_for: S35-trending
rules_hash: e3b0c44298fc
---
# trendingMerges
## Definition
`trendingMerges` is a metric owned by the trending capability. It is declared next to `trendingEvents` and "related counters". Going by its name, it covers the window merges that the trending consumer runs into the trending aggregate. It probably exists so operators can see whether merges succeed, get retried or fail when the aggregate store is down. That purpose is design intent (not stated in the spec).

## Example
The aggregate store is down when a window closes (S35 AS-35). The merge is retried with backoff and jitter, up to 3 attempts per cycle, and no later offset is committed.
Illustrative only: the spec does not confirm that these attempts are recorded in `trendingMerges`.

## Known gaps
- The spec does not say what `trendingMerges` counts or which labels it has. It also does not say whether a replayed merge that leaves the aggregate unchanged (S35 AS-31) is counted separately.
- The spec does not show this metric is tested, because AS-36 (metrics and privacy) has no test with its id.
- Not confirmed in the code: that `trendingMerges` exists, its type or its exported name. The notes cite only `trending-metrics.ts#trendingEvents`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
