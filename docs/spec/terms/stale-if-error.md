---
id: stale-if-error
title: Stale-if-error (staleIfErrorMs)
kind: term
status: draft
aliases: [stale-if-error, staleiferrorms]
defined_for: cache-layers
rules_hash: 20557e3367c1
---
# Stale-if-error (staleIfErrorMs)
## Definition
Stale-if-error, set with `staleIfErrorMs`, lets [the toolkit](cache-toolkit.md) keep serving an expired value when [the loader](loader.md) fails. The stale value is returned instead of the error until [`exp + staleIfErrorMs`](soft-expiry.md). After that, the loader's error reaches the caller. [Negative entries](negative-caching.md) ignore this option. Design intent (not stated in the spec): it keeps reads working through a short database or upstream outage.

## Example
An illustrative entry has `exp` at 12:00:00 and `staleIfErrorMs: 300000` (5 minutes). The loader rejects at 12:02, so the caller gets the stale value. If the loader rejects again at 12:06, the caller gets the error.

## Known gaps
- The spec does not say whether the caller can tell that it got a stale value, for example through an outcome label.
- The spec does not say whether stale-if-error applies to [background SWR refreshes](stale-while-revalidate.md), foreground loads, or both.

## Used by
<!-- used-by:start -->
- [cache-layers](../concepts/cache-layers.md): C-05
- [cache-entry](cache-entry.md)
- [cache-loader-busy](cache-loader-busy.md)
- [cache-toolkit](cache-toolkit.md)
- [loader](loader.md)
- [negative-caching](negative-caching.md)
- [soft-expiry](soft-expiry.md)
- [stale-while-revalidate](stale-while-revalidate.md)
<!-- used-by:end -->
