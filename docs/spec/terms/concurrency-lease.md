---
id: concurrency-lease
title: Concurrency lease
kind: term
status: draft
aliases: [lease]
defined_for: S50-rate-limiter
rules_hash: 0ee20365c27c
---
# Concurrency lease
## Definition
A concurrency lease is a slot that one in-progress operation holds in the [shared store](rate-limit-counter-store.md), under a [concurrency policy](concurrency-limit.md). A [subject](rate-limit-subject.md) can hold only as many unexpired leases at once as the policy's limit allows. Every lease expires after the policy's [`windowMs`](window-ms.md), so a holder that crashes still frees its slot. When an [`acquire`](acquire.md) is denied, it reports a [`retryAfterMs`](retry-after-ms.md) clamped to a fixed range. A lease taken for an HTTP request is released when the request succeeds, throws, or the client aborts.

## Example
A route has a concurrency limit of 2 and a handler that takes 300 ms. While two requests are still running, a third one gets `429` with `Retry-After >= 1` (B-05).

## Known gaps
- The spec does not say whether a holder can extend a lease. Work that runs longer than `windowMs` loses its slot, and another caller can then be admitted.
- The spec does not say how a concurrency lease behaves under [fail open ↗](../sw-external-terms.md#fail-open-fail-closed), since the fallback limiter is described as a token bucket.

## Used by
<!-- used-by:start -->
- [S50](../capabilities/S50-rate-limiter.md): R-10, R-11, R-12
- [acquire](acquire.md)
- [client-abort](client-abort.md)
- [concurrency-lease-release](concurrency-lease-release.md)
- [concurrency-limit](concurrency-limit.md)
- [extraction-worker](extraction-worker.md)
- [pending-row](pending-row.md)
- [rate-limit-budget](rate-limit-budget.md)
- [rate-limit-counter-store](rate-limit-counter-store.md)
- [rate-limit-policy-change](rate-limit-policy-change.md)
- [rate-limit-subject](rate-limit-subject.md)
- [relay-poller-mode](relay-poller-mode.md)
- [window-ms](window-ms.md)
<!-- used-by:end -->
