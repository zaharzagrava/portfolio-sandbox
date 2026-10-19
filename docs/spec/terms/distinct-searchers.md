---
id: distinct-searchers
title: Distinct searchers
kind: term
status: draft
aliases: [searchers]
defined_for: S33-autocomplete
rules_hash: d04332d3f4ad
---
# Distinct searchers
## Definition
Distinct searchers is the popularity measure for a past query: the number of different people who searched it during the recent period of search history being counted, not the number of searches. The hourly job that rebuilds the suggestion data counts it after removing duplicate rows by [event id](event-id.md), and the result does not depend on row order. A query is published only if enough different people who are allowed to count searched it to meet the minimum required. Query suggestions are ranked by this count. Counting people instead of searches is design intent (not stated in the spec): it stops one person from pushing a query into everyone's suggestions.

## Example
One searcher types `cheap iphone` 100 times. That query has only one distinct searcher, so the build does not publish it.

## Known gaps
- The spec does not say how a searcher is identified, for example by user id or anonymous id, or how signed-out searchers are counted.
- The spec does not define what makes a searcher "eligible".

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-07, R-19, R-20, B-02
- [S34](../capabilities/S34-recommendations.md): R-16
- [S35](../capabilities/S35-trending.md): B-10
- [autocomplete-build](autocomplete-build.md)
- [build-window](build-window.md)
- [decode-snapshot](decode-snapshot.md)
- [eligible-query](eligible-query.md)
- [eligible-searcher](eligible-searcher.md)
- [event-id](event-id.md)
- [popularity-floor](popularity-floor.md)
- [published-query](published-query.md)
- [query-index-build](query-index-build.md)
- [query-log](query-log.md)
- [query-snapshot](query-snapshot.md)
- [query-suggestion](query-suggestion.md)
- [query-suggestions](query-suggestions.md)
- [search-build-autocomplete](search-build-autocomplete.md)
- [search-log](search-log.md)
- [snapshot](snapshot.md)
- [suggest-ordering](suggest-ordering.md)
- [suggestion-build](suggestion-build.md)
- [verification-gate](verification-gate.md)
<!-- used-by:end -->
