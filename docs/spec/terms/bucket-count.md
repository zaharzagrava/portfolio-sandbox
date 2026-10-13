---
id: bucket-count
title: Bucket count
kind: term
status: draft
aliases: [bucket, buckets]
defined_for: S34-recommendations
rules_hash: 512693eb81ed
---
# Bucket count
## Definition
The bucket count is the `buckets` [build parameter](order-baskets-build.md) of the [order baskets build](order-baskets-build.md). It is checked together with `days` before the build reads or writes anything, and an out-of-range value fails the build. The rules require every [neighbour list](direct-neighbour.md) to come out the same whatever bucket count is used. The bucket count may change how the work is split up, but never the result.

## Example
A build run with `{"days": 180, "buckets": 16}` and another run with `{"days": 180, "buckets": 4}` (illustrative) over the same [baskets](basket.md) must write identical lists for product `M`.

## Known gaps
- The spec does not say what a bucket is or how the build divides baskets or products into buckets. Splitting the work into smaller parts to limit memory or query size is design intent (not stated in the spec).
- The spec does not say how an operator chooses a value other than the default.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-18
- [basket](basket.md)
- [direct-neighbour](direct-neighbour.md)
- [neighbour-list](neighbour-list.md)
- [order-baskets-build](order-baskets-build.md)
- [recommendations-config](recommendations-config.md)
<!-- used-by:end -->
