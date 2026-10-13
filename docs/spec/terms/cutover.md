---
id: cutover
title: Cutover (reindex)
kind: term
status: draft
aliases: [cutover]
defined_for: search-index
rules_hash: 15c02226a055
---
# Cutover (reindex)
## Definition
Cutover is the step in a [zero-downtime reindexing](zero-downtime-reindexing.md) run where live search moves from the [previous index](search-index.md) to the new index. It comes after verification. A run that fails with [`verification_failed`](verification-failed.md) never reaches cutover, and the live index stays untouched. Before cutover, buyers and sellers search the old index. After it, they search the new one. Design intent (not stated in the spec): the switch should be one step, so search never answers from an empty or half-built index.

## Example
An [S32](../capabilities/S32-product-search.md) reindex run builds a new index from catalog events. Verification finds at least as many documents as the history requires. At cutover, buyer and seller search start answering from the new index instead of the previous index.

## Known gaps
- The spec does not say how cutover happens (for example, an alias swap or a config change), or whether it is atomic.
- The spec does not say how catalog events that arrive during the run reach the new index before cutover, or whether any can be missed.
- The spec does not say what [reindex rollback](reindex-rollback.md) restores after cutover, how long the previous index is kept, or exactly when the [search.retire-previous-index job](search-retire-previous-index.md) removes it.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-17
- [live-index-alias](live-index-alias.md)
- [reindex-rollback](reindex-rollback.md)
- [search-index](search-index.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [search-total-order](search-total-order.md)
- [verification-failed](verification-failed.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
