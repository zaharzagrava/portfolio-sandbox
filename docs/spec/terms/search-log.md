---
id: search-log
title: Search log
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: f8e65fa7257a
---
# Search log
## Definition
The search log is [S32](../capabilities/S32-product-search.md)'s record of past searches. Each row carries an [event id](event-id.md). The feature that suggests queries as people type does not own the log; it only reads it, and [the autocomplete build](autocomplete-build.md) is its only reader there. The build turns the log into counts of [distinct searchers](distinct-searchers.md) per query.

## Example
If one searcher runs `cheap iphone` 100 times, the log holds 100 rows but they count as one searcher. The query is not [published](published-query.md) (S33.B-13). If two rows share the same event id, the build counts them once (S33.R-19).

## Known gaps
- The spec does not say what a log row contains apart from the event id, query text, searcher and timestamp that the rules imply.
- The spec does not say how long S32 keeps log rows, or how the build's configured window maps onto them.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-13
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-worker-module](autocomplete-worker-module.md)
- [build-window](build-window.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-query](eligible-query.md)
- [event-id](event-id.md)
- [published-query](published-query.md)
- [query-index-build](query-index-build.md)
- [query-index](query-index.md)
- [search-build-autocomplete](search-build-autocomplete.md)
- [search-quality-report](search-quality-report.md)
- [suggest-builder](suggest-builder.md)
- [suggestion-build](suggestion-build.md)
<!-- used-by:end -->
