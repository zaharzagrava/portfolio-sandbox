---
id: jitter
title: Jitter
kind: term
status: draft
aliases: []
defined_for: cache-layers
rules_hash: 4474a3d100e1
---
# Jitter
## Definition
Jitter is a random spread that the [cache toolkit](cache-toolkit.md) applies to every cache lifetime. Because of it, [entries](cache-entry.md) written at the same moment do not all expire at the same moment. The `jitter` setting is a fraction of the lifetime, with a default and an allowed range set in the rules. The reason, design intent (not stated in the spec): it stops many keys from expiring together and flooding the [loaders](loader.md) and database all at once.

## Example
With `jitter` = 0.1 and a lifetime of 60 s (illustrative), each entry's real lifetime lands somewhere near 60 s, within about ±6 s, instead of exactly 60 s.

## Known gaps
- The spec does not say whether jitter can lengthen a lifetime or only shorten it.
- The spec does not say which lifetimes are jittered, for example [`l1TtlMs`](l1-ttl-ms.md), [`swrMs`](stale-while-revalidate.md), [`negativeTtlMs`](negative-caching.md) or the recompute lock.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-14
- [S10](../capabilities/S10-cart-checkout.md): R-28
- [S35](../capabilities/S35-trending.md): B-17
- [S49](../capabilities/S49-job-scheduler.md): R-12
- [S52](../capabilities/S52-cache-toolkit.md): R-01, R-15
- [cache-layers](../concepts/cache-layers.md): C-08
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-05
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-06
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [job-retry-delay](job-retry-delay.md)
- [loader](loader.md)
- [outbox-relay](outbox-relay.md)
- [search-refresh-popularity](search-refresh-popularity.md)
- [soft-expiry](soft-expiry.md)
- [upstream-unavailable](upstream-unavailable.md)
<!-- used-by:end -->
