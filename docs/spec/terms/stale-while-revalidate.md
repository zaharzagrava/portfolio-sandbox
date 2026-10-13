---
id: stale-while-revalidate
title: Stale-while-revalidate (swrMs)
kind: term
status: draft
aliases: [swr, swrms]
defined_for: cache-layers
rules_hash: 2260d140ffb3
---
# Stale-while-revalidate (swrMs)
## Definition
Stale-while-revalidate, set with `swrMs`, is a window that begins once an entry has passed the point where it should be refreshed. During it, a [stale entry](cache-entry.md) is returned to the caller at once while [the toolkit](cache-toolkit.md) refreshes it in the background. The caller never waits for [the loader](loader.md) during this window. Only one background refresh runs per stale entry. Entries that store a failed or empty lookup ignore this window.

## Example
Here is an illustrative `getOrLoad` call for a product page with `swrMs: 30000`. Fifteen seconds past soft expiry, a reader gets the old product data with no wait, and one refresh reloads it from the database in the background.

## Known gaps
- The spec does not say what happens to the entry if the background refresh fails and [`staleIfErrorMs`](stale-if-error.md) is not set.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-14, R-15
- [S52](../capabilities/S52-cache-toolkit.md): R-16
- [cache-layers](../concepts/cache-layers.md): C-05
- [cache-entry](cache-entry.md)
- [cache-toolkit](cache-toolkit.md)
- [hot-key](hot-key.md)
- [loader](loader.md)
- [negative-caching](negative-caching.md)
- [soft-expiry](soft-expiry.md)
- [stale-if-error](stale-if-error.md)
<!-- used-by:end -->
