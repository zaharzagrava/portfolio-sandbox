---
id: reindex-history
title: Reindex history requirement
kind: term
status: draft
aliases: [history]
defined_for: S32-product-search
rules_hash: e361c272a436
---
# Reindex history requirement
## Definition
The reindex history is the record of past [reindex runs](reindex-run-status.md) that [S32](../capabilities/S32-product-search.md) keeps alongside the runs themselves. The [verification gate](verification-gate.md) uses it as a baseline: a new index must hold at least the number of documents the history requires. A new build that falls short of what earlier runs produced is treated as broken, not as a real drop in products. This is design intent (not stated in the spec).

## Example
Say the last completed run produced 10,000 documents and a new run builds only 6,000. The gate compares the two, fails the run with [`verification_failed`](verification-failed.md), and the [live index](live-index-alias.md) is not touched. (All numbers are illustrative.)

## Known gaps
- The spec does not say what the history stores (document counts, timestamps or something else), or how the required minimum is derived from it.
- The spec does not say what happens on the very first run, when there is no history. "First start" is listed only by its [proof id](rule-proof.md).
- The spec does not say how long run history is retained.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-20
- [live-index-alias](live-index-alias.md)
- [reindex-run-status](reindex-run-status.md)
- [rule-proof](rule-proof.md)
- [verification-gate](verification-gate.md)
<!-- used-by:end -->
