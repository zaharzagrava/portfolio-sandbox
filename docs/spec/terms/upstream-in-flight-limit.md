---
id: upstream-in-flight-limit
title: Upstream in-flight limit
kind: term
status: draft
aliases: [in-flight limit, upstream_overloaded]
defined_for: bff-aggregate
rules_hash: 80de37156b86
---
# Upstream in-flight limit
## Definition
The [upstream](upstream.md) in-flight limit caps how many calls to an upstream the [BFF ↗](../sw-external-terms.md#bff) can have open at the same time. When the cap is reached, the BFF does not start another call. That [optional section](required-section.md) comes back `null` with an [`errors` entry](errors-entry.md) carrying `UPSTREAM_OVERLOADED`. The [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) reacts to repeated failures, but this limit reacts only to how many calls are open at once. Design intent (not stated in the spec): it keeps a slow upstream from piling up waiting calls and using up the [page deadline](page-deadline.md) of many pages at once.

## Example
100 calls to the `recommendations` upstream are already in flight, and one more product-page request arrives. The BFF does not call it. `recommendations` is `null`, and the response has this entry:
```json
{ "section": "recommendations", "code": "UPSTREAM_OVERLOADED", "retryable": true }
```
(`retryable: true` is illustrative.)

## Known gaps
- Not confirmed in the code: whether the limit counts calls for each upstream separately or for all upstreams together.
- The spec does not say what happens when the required `product` section hits the limit. The facts list `UPSTREAM_OVERLOADED` only for optional sections.
- The spec does not say whether a call refused by this limit counts as a failure for the upstream's circuit breaker.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-09
- [concurrency-limit](concurrency-limit.md)
- [errors-entry](errors-entry.md)
- [load-shedding](load-shedding.md)
- [page-deadline](page-deadline.md)
- [rate-limit](rate-limit.md)
- [required-section](required-section.md)
- [upstream](upstream.md)
<!-- used-by:end -->
