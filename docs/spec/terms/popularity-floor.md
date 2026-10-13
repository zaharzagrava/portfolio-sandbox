---
id: popularity-floor
title: Popularity floor
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Popularity floor
## Definition
The popularity floor is the minimum number of different people a query must have been searched by before it is kept. A query below the floor is left out of the [snapshot](suggest-snapshot.md), so it never becomes a [query suggestion](query-suggestion.md). The floor is a configuration value and is checked when the service starts. It stops queries that only one person or a few people searched from appearing in everyone's suggestions. That reason is design intent (not stated in the spec).

## Example
One searcher types the same query 100 times. That query has one distinct searcher, which is below the floor, so the build does not [publish](suggest-publish.md) it ([S33 AS-28](acceptance-scenario.md)).

## Known gaps
- The spec does not give the default value of the floor.
- The spec does not say whether a query whose count exactly equals the floor is kept or dropped.
- Not confirmed in the code: the spec names no code reference for where the floor is applied in the build.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [autocomplete-build](autocomplete-build.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-query](eligible-query.md)
- [eligible-searcher](eligible-searcher.md)
- [published-query](published-query.md)
- [query-index-build](query-index-build.md)
- [query-log](query-log.md)
- [query-suggestion](query-suggestion.md)
- [suggest-publish](suggest-publish.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-build](suggestion-build.md)
<!-- used-by:end -->
