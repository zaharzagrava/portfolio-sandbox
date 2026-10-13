---
id: suggest-snapshot
title: Suggest snapshot
kind: term
status: draft
aliases: [snapshot]
defined_for: S33-autocomplete
rules_hash: 9e7d3975c472
---
# Suggest snapshot
## Definition
The suggest snapshot is the versioned file that the offline build job publishes to [object storage ↗](../sw-external-terms.md#object-storage) as `autocomplete/<version>`. It holds only `{query, [searchers](distinct-searchers.md)}` pairs and the build parameters, and it carries a [checksum ↗](../sw-external-terms.md#checksum). Every serving node downloads the snapshot whose version is currently marked as live, builds its in-memory [top-K trie ↗](../sw-external-terms.md#trie) from it, and answers requests from that trie. If the snapshot is damaged, decoding fails with a typed reason, and the node keeps serving the index it already has. Keeping only these pairs, with no searcher identities, is design intent (not stated in the spec): it keeps personal data out of the file every node downloads.

## Example
After a successful build, the object `autocomplete/<version>` exists, the pointer equals `<version>`, and its checksum verifies. One entry, with illustrative values and shape:
```json
{ "query": "iphone case", "searchers": 42 }
```

## Known gaps
- The spec does not say what encoding the snapshot uses, which checksum algorithm it uses, or exactly which build parameters it stores.
- The spec does not list the typed decode failure reasons. The only hint is the `reason` label on `autocomplete_snapshot_load_failed_total`.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-17, R-18, R-21
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-snapshot-age-seconds](autocomplete-snapshot-age-seconds.md)
- [autocomplete-worker-module](autocomplete-worker-module.md)
- [blocklist-reload](blocklist-reload.md)
- [build-end-states](build-end-states.md)
- [degraded-response](degraded-response.md)
- [degraded](degraded.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-query](eligible-query.md)
- [eligible-searcher](eligible-searcher.md)
- [failure-counter](failure-counter.md)
- [load-failure-reason](load-failure-reason.md)
- [node](node.md)
- [popularity-floor](popularity-floor.md)
- [published-version](published-version.md)
- [readiness](readiness.md)
- [serve-time](serve-time.md)
- [serving-node](serving-node.md)
- [snapshot](snapshot.md)
- [suggest-builder](suggest-builder.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggest-publish](suggest-publish.md)
- [suggestion-source](suggestion-source.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
