---
id: suggest-index
title: Suggest index
kind: term
status: draft
aliases: [index]
defined_for: S33-autocomplete
rules_hash: d76ffd4be15e
---
# Suggest index
## Definition
The suggest index is the in-memory query index on each [serving node](readiness.md). Each node builds it from the [published snapshot](suggest-publish.md) that the [version pointer](version-pointer.md) names. It is a [top-K trie ↗](../sw-external-terms.md#trie): each prefix stores its own precomputed best queries, so a lookup costs time proportional to the prefix length. When a new snapshot loads, the node [swaps in the new index without downtime](hot-swap.md). A request always reads one whole index and never a mix of two versions.

## Example
A node is serving `V1`, and the pointer moves to `V2`. During the swap, 200 concurrent `GET /api/suggest?q=iph` calls all answer `200`, and each answer matches exactly one version. If `autocomplete/V2` is damaged, the node keeps serving `V1`.

## Known gaps
- The spec does not say whether the node holds the old index in memory alongside the new one during a swap, or how much memory one index needs.
- Not confirmed in the code: how the swap is made atomic for requests already in progress inside `QueryIndexService`.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-24
- [blended-suggestions](blended-suggestions.md)
- [hot-swap](hot-swap.md)
- [readiness](readiness.md)
- [suggest-publish](suggest-publish.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
