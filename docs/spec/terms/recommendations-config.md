---
id: recommendations-config
title: recommendations-config.ts
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: e3b0c44298fc
---
# recommendations-config.ts
## Definition
`recommendations-config.ts` is the configuration file for the [bought-together capability (S34)](../capabilities/S34-recommendations.md). It holds the [co-order threshold](co-order-threshold.md), the [distinct buyers threshold](distinct-buyers-threshold.md), the [build window](build-window.md) and [bucket count](bucket-count.md) defaults, the [list caps](neighbour-list.md), the [TTLs ↗](../sw-external-terms.md#time-to-live) and the time budgets. These values are validated when the service starts. Design intent (not stated in the spec): validating at startup means a bad value stops the service at boot, before it can reach a build or a request.

## Example
These are the values that the S34 rules state for the kinds of setting this file holds. The spec does not give the key names, so the left column only describes each setting.
```
co-order threshold ............ 3         (S34.R-16)
distinct buyers threshold ..... 3         (S34.R-16)
build window `days` default ... 180       (S34.R-22)
`buckets` default ............. 16        (S34.R-22)
list cap ...................... 20 edges  (S34.R-18)
neighbour list TTL ............ 3 days    (S34.R-19)
list store / product / shop ... 100 / 100 / 50 ms budgets (S34.R-13)
```

## Known gaps
- Not confirmed in the code: startup validation of this configuration (FR-029) is unverified. AS-50 and AS-51 have test ids, but the work-order text does not state what they cover.
- The spec does not say which other values are in this file: the damping factor (0.5), the expansion seed count (5), the build-lock lease (1 hour) or the `discovery.recommendations` rate limit (600 per minute). The rate limit may be in `rate-limit-policies.ts` instead.
- The spec does not give the file's full path, its key names, or whether values can be changed per environment without a code change.

## Used by
<!-- used-by:start -->
- [bucket-count](bucket-count.md)
- [build-window](build-window.md)
- [co-order-threshold](co-order-threshold.md)
- [distinct-buyers-threshold](distinct-buyers-threshold.md)
- [neighbour-list](neighbour-list.md)
<!-- used-by:end -->
