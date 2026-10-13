---
id: eligible-searcher
title: Eligible searcher
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: 11484b06c555
---
# Eligible searcher
## Definition
An eligible searcher is a [distinct searcher](distinct-searchers.md) whose searches the [autocomplete build](autocomplete-build.md) counts toward a query's popularity. The build counts people, not searches, so repeating a query does not raise its count. A query is shown as a suggestion only when enough distinct eligible searchers have searched it. The [popularity floor](popularity-floor.md) in configuration sets how many is enough.

## Example
One searcher repeats `iphone case` 100 times. That is one eligible searcher, which is below the popularity floor, so `iphone case` is left out of the [snapshot](suggest-snapshot.md) (S33.B-13).

## Known gaps
- The spec does not say what makes a searcher eligible or ineligible. For example, it does not say whether anonymous searchers or [blocklisted queries](autocomplete-blocklist.md) are excluded.
- The spec does not say how a searcher is identified in the log (user id, anonymous id or address).
- The spec does not give the default value of the popularity floor.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-13
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-build](autocomplete-build.md)
- [distinct-searchers](distinct-searchers.md)
- [popularity-floor](popularity-floor.md)
- [published-query](published-query.md)
- [query-log](query-log.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-build](suggestion-build.md)
<!-- used-by:end -->
