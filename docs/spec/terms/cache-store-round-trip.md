---
id: cache-store-round-trip
title: Store round trip
kind: term
status: draft
aliases: [store call]
defined_for: S52-cache-toolkit
rules_hash: 1a44fdccf973
---
# Store round trip
## Definition
A store round trip is one request sent from an instance to the [shared store (L2)](l2-cache.md) and its reply. The [toolkit](cache-toolkit.md) groups work to keep round trips few. [`getOrLoadMany`](get-or-load.md) reads all keys in one store read. [`invalidate`](invalidate.md) removes duplicate keys and sends the rest in batches, so the number of round trips stays bounded. An empty key list makes no store call at all.

## Example
`invalidate` with 5,000 keys, some of them duplicates, makes at most 10 store round trips.
`invalidate([])` makes 0.
`getOrLoadMany` with 100 keys reads the store once.

## Known gaps
- The spec does not say how many keys go into one round trip.
- The spec does not say whether the [`cache:invalidate` broadcast](cache-invalidate-channel.md) publish counts toward the round-trip limit.

## Used by
<!-- used-by:start -->
- [S52](../capabilities/S52-cache-toolkit.md): B-12
- [cache-invalidate-channel](cache-invalidate-channel.md)
- [cache-toolkit](cache-toolkit.md)
- [l2-cache](l2-cache.md)
<!-- used-by:end -->
