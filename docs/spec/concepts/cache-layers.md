---
id: cache-layers
title: Layered cache and single-flight
kind: concept
status: draft
defined_by: S52
---
# Layered cache and single-flight
## Definition
Layered cache and single-flight is the shared way every domain keeps fast copies of data that is read far more often than it changes. Capability S52 provides it as one toolkit. The database always wins, every copy can be rebuilt, and the toolkit never owns business data. Readers get a cached value from an in-process layer (L1) or a shared layer (L2) before any loader runs. Concurrent misses for one key trigger one loader call.

## Rules
- **cache-layers.C-01** [`getOrLoad`](../terms/get-or-load.md) MUST read [L1](../terms/l1-cache.md) (when enabled for the key), then [L2](../terms/l2-cache.md), then the [loader](../terms/loader.md), and MUST NOT cache a loader error or an `undefined` result.
- **cache-layers.C-02** [L1](../terms/l1-cache.md) MUST hold at most 10,000 [entries](../terms/cache-entry.md) and 64 MiB by default, MUST drop the [least recently used ↗](../sw-external-terms.md#lru-eviction) entries first, and MUST NOT keep a copy longer than [`l1TtlMs`](../terms/l1-ttl-ms.md) (default 1,000 ms, maximum 5,000 ms).
- **cache-layers.C-03** [Concurrent misses](../terms/single-flight.md) for one key in one process MUST share one loader call, including a [rejection](../terms/loader.md). Across instances, one process MUST hold the [per-key recompute lock](../terms/recompute-lock.md) (lifetime 5 s).
- **cache-layers.C-04** Past its [soft expiry](../terms/soft-expiry.md) and inside [`swrMs`](../terms/stale-while-revalidate.md), an entry MUST be returned at once with one background refresh. With [`staleIfErrorMs`](../terms/stale-if-error.md), a rejecting loader MUST return the stale value until `exp + staleIfErrorMs`.
- **cache-layers.C-05** A `null` result MUST be stored only when [`negativeTtlMs`](../terms/negative-caching.md) is set, and negative entries MUST ignore [SWR](../terms/stale-while-revalidate.md) and [stale-if-error](../terms/stale-if-error.md).
- **cache-layers.C-06** An entry larger than [`maxEntryBytes`](../terms/max-entry-bytes.md) (default 256 KiB, maximum 1 MiB) MUST be returned to the caller and MUST NOT be stored in [L1](../terms/l1-cache.md) or [L2](../terms/l2-cache.md).
- **cache-layers.C-07** The [toolkit](../terms/cache-toolkit.md) MUST NOT expose any method that stores a caller-supplied value, so [writers only delete](../terms/invalidation-only-writes.md). [`invalidate`](../terms/invalidate.md) MUST NOT throw on store failure; it MUST resolve [`{l2: 'failed', deleted: 0}`](../terms/invalidate-result.md) and [evict](../terms/l1-cache.md) the local L1 copy.
- **cache-layers.C-08** Lifetimes MUST be [jittered](../terms/jitter.md) by `jitter` (default 0.1, range 0 to 0.5), and an [unparseable stored entry](../terms/corrupt-entry.md) MUST count as a [miss](../terms/cache-miss.md) (outcome `corrupt`) and be overwritten.

## How the capabilities use it
- {{cap:S52}} defines the toolkit: L1/L2, single-flight, XFetch, SWR, negative cache, Bloom filter, write-behind counters, distributed lock and HTTP validators.
- {{cap:S05}} serves product pages through the layered cache, so anyone reads a product page quickly and safely.
- {{cap:S48}} lets the shared cache hold a public section only as long as the upstream's `s-maxage` allows, and single-flights public upstream calls.

## Known gaps
- S03, S33, S34, S35 and W02 list this concept, but the facts contain no line that says how they use it.
- The facts do not say how S05 invalidates its cache.

## Used by
<!-- used-by:start -->
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S52}} Cache toolkit: L1/L2, single-flight, XFetch, SWR, negative cache, write-behind counters, ETags
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
<!-- used-by:end -->
