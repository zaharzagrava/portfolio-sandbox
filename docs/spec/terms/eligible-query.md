---
id: eligible-query
title: Eligible query
kind: term
status: draft
aliases: [eligible queries]
defined_for: S33-autocomplete
rules_hash: 59f64738c6c6
---
# Eligible query
## Definition
An eligible query is a [search-log](search-log.md) query that may enter the [suggest snapshot](suggest-snapshot.md). It must not contain a [blocklisted term](suggestion-blocklist.md); the check is `containsBlocked` in `query-eligibility.ts`. It must also have enough [distinct eligible searchers](distinct-searchers.md) to reach the [popularity floor](popularity-floor.md). If a build finds no eligible queries, it ends `skipped_empty` and publishes nothing. The blocklist is checked again for every suggestion when it is served, so a blocklist change takes effect without waiting for a new build.

## Example
`cheap iphone` stops being eligible once `cheap` is on the blocklist. A query that a single searcher repeated 100 times is not eligible either, because it lacks enough distinct searchers.

## Known gaps
- The spec does not say what makes a searcher "eligible". Other filters may also apply, such as query length or reduction like S33.R-03.
- The spec does not give the default popularity floor or the default window.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-23
- [S34](../capabilities/S34-recommendations.md): R-20
- [build-end-states](build-end-states.md)
- [distinct-searchers](distinct-searchers.md)
- [popularity-floor](popularity-floor.md)
- [search-log](search-log.md)
- [suggest-builder](suggest-builder.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-blocklist](suggestion-blocklist.md)
<!-- used-by:end -->
