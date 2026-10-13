---
id: query-index
title: Query index (suggest)
kind: term
status: draft
aliases: [query index]
defined_for: S33-autocomplete
rules_hash: 115739876755
---
# Query index (suggest)
## Definition
The query index is the in-memory structure on each serving node that answers query suggestions for a prefix. It is a [top-K trie ↗](../sw-external-terms.md#trie) built from the latest published snapshot of the [search log](search-log.md). Every trie prefix stores its own precomputed top K, so the cost of a lookup grows only with the length of the prefix. [`QueryIndexService`](query-index-service.md) polls the [version pointer](version-pointer.md) and swaps in a new index without downtime, and each request sees one index from start to finish. If no index is loaded, the answer still succeeds but lists [`query_index_unavailable`](degraded-marker.md) in `degraded`.

## Example
The builder publishes `autocomplete/<version>`. Within one poll interval, each node downloads it, decodes it, checks its [checksum](autocomplete-checksum.md) and swaps it in. A request for `q=iph` then reads `iphone case` and `iphone cable` from the new index.

## Known gaps
- The spec does not say what happens when the requested query share is larger than the configured K.
- The spec does not give the configured trie depth or say how prefixes longer than that depth are answered. B-06 only shows that a 35-character prefix still matches.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-05
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-object](autocomplete-object.md)
- [degraded](degraded.md)
- [hot-swap](hot-swap.md)
- [node](node.md)
- [query-index-service](query-index-service.md)
- [query-suggestion](query-suggestion.md)
- [search-build-autocomplete](search-build-autocomplete.md)
- [search-log](search-log.md)
- [slot-budget](slot-budget.md)
- [snapshot](snapshot.md)
- [suggestion-source](suggestion-source.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
