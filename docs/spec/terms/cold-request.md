---
id: cold-request
title: Cold request
kind: term
status: draft
aliases: [cold requests]
defined_for: S35-trending
rules_hash: 330780b8dfe7
---
# Cold request
## Definition
A cold request is a request to [`GET /api/trending`](get-trending.md) that finds no [ready ranking](trending-ranking-cache.md), so it must read the [trending aggregate](trending-aggregate.md). When several cold requests for the same ranking arrive together, they share one aggregate read instead of each reading the store. This is [single-flight ↗](../sw-external-terms.md#single-flight) applied to trending. It protects the aggregate store when a cached ranking expires under load (design intent, not stated in the spec).

## Example
Fifty buyers open the home page at the same moment, just after the [`category=all`](all-bucket.md) ranking expired. The backend makes one aggregate read, and all fifty requests get their answer from it.

## Known gaps
- The spec does not say what makes two requests "the same ranking" (category only, or category and `limit`).
- The spec does not say what happens to the waiting requests if the shared read fails. Presumably all of them get [`trending_unavailable`](trending-unavailable.md), but this is not confirmed.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-12
- [trending-aggregate](trending-aggregate.md)
- [trending-ranking-cache](trending-ranking-cache.md)
<!-- used-by:end -->
