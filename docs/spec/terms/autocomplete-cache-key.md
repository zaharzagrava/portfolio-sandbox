---
id: autocomplete-cache-key
title: Autocomplete cache key (query normalisation)
kind: term
status: draft
aliases: [q=iph]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Autocomplete cache key (query normalisation)
## Definition
The autocomplete cache key is the [reduced prefix](reduced-prefix.md) that the [catalog-results cache](catalog-completions.md) uses to store answers. The endpoint first reduces `q` the way [S32](../capabilities/S32-product-search.md) reduces search text, then looks up the cache with that text. Inputs that differ only in case, spacing or [compatibility forms ↗](../sw-external-terms.md#unicode-compatibility-folding) reduce to the same key and share [one entry](cache-entry.md). Failed or timed-out catalog calls are never stored under any key.

## Example
With a healthy engine, three calls to `GET /api/suggest?q=iph` and one call to `GET /api/suggest?q=IPH` within 60 seconds all reduce to the key `iph`. The engine is called only once (S33.B-12).

## Known gaps
- The spec does not say whether [`limit`](suggest-limit.md) is part of the cache key, or whether one cached catalog result serves every `limit`.
- The spec does not say where this cache lives: per process on each node, or in a shared store.
- Not confirmed in the code: the spec cites no class or file for the catalog cache.

## Used by
<!-- used-by:start -->
- [cache-entry](cache-entry.md)
- [catalog-completions](catalog-completions.md)
- [reduced-prefix](reduced-prefix.md)
<!-- used-by:end -->
