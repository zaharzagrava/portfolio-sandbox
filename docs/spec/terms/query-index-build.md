---
id: query-index-build
title: Query index build
kind: term
status: draft
aliases: [build]
defined_for: S33-autocomplete
rules_hash: fc5def4c0b29
---
# Query index build
## Definition
The query index build is one run of the job [`search.build-autocomplete`](search-build-autocomplete.md). It reads [S32's search log](search-log.md), applies the [blocklist](suggestion-blocklist.md) and removes duplicate rows by [event id](event-id.md). It then counts [distinct searchers](distinct-searchers.md) per query and keeps the top queries up to the configured cap. It encodes those queries as a snapshot with a [checksum ↗](../sw-external-terms.md#checksum), writes [`autocomplete/<version>`](autocomplete-object.md) and moves the [version pointer](version-pointer.md) forward. Each run ends published, [`unchanged`](build-end-states.md), `skipped_empty` or `superseded`.

## Example
The search log has one buyer typing `iphone case` 100 times. The build counts one searcher, so the query falls below the [popularity floor](popularity-floor.md) and is not published. If no query is eligible at all, the build ends `skipped_empty` and publishes nothing.

## Known gaps
- The spec does not give the default values for the popularity floor or the log window. It gives only the cap (default 200,000).
- The spec does not say how `unchanged` is detected (by comparing entries with the snapshot the pointer names, or some other way).

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-17
- [distinct-searchers](distinct-searchers.md)
- [event-id](event-id.md)
- [popularity-floor](popularity-floor.md)
- [search-log](search-log.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [superseded-build](superseded-build.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
