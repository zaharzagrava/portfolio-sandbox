---
id: published-query
title: Published query
kind: term
status: draft
aliases: [published]
defined_for: S33-autocomplete
rules_hash: 051cd4e53187
---
# Published query
## Definition
A published query is a past search text that the hourly [`search.build-autocomplete` job](autocomplete-build.md) kept and wrote into a snapshot [`autocomplete/<version>`](autocomplete-object.md). The [version pointer](version-pointer.md) must name that snapshot. The build counts [distinct searchers](distinct-searchers.md), not searches. It drops blocklisted text and queries below the [popularity floor](popularity-floor.md), and it keeps only the top entries up to the configured cap. Serving nodes load the pointed snapshot and return a published query for any prefix of it. The blocklist is checked again at serve time, so a newly blocked query disappears without a new build.

## Example
A published query of 46 characters is returned for a `q` that is its 24-character or 35-character prefix. In contrast, a query that one searcher repeated 100 times is never published.

## Known gaps
- The spec does not give the default popularity floor or the default log window.
- The spec does not say how many distinct searchers make "enough" for a query to be kept.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-06
- [autocomplete-build](autocomplete-build.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-searcher](eligible-searcher.md)
- [popularity-floor](popularity-floor.md)
- [search-log](search-log.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
