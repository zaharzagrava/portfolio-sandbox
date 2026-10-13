---
id: query-log
title: Query log
kind: term
status: draft
aliases: [published log]
defined_for: S33-autocomplete
rules_hash: f69438637d65
---
# Query log
## Definition
The query log is [S32](../capabilities/S32-product-search.md)'s store of past searches, and it is the input to the autocomplete build. [The hourly build](autocomplete-build.md) reads it, removes duplicate rows by [event id](event-id.md), applies the [blocklist](autocomplete-blocklist.md), and counts [distinct searchers](distinct-searchers.md) for each query. The most popular queries become the [snapshot](query-snapshot.md). "Published log" in the scenarios means a log whose queries have already been built into a published snapshot. Autocomplete only reads this store; S32 owns it.

## Example
One searcher types `iphone case` 100 times. The build counts one searcher, so the query is not published. If enough distinct [eligible](eligible-searcher.md) searchers type it, it appears for `q=iph`.

## Known gaps
- The spec does not say what identifies a searcher, for example a user id or an anonymous id.
- The spec does not give default values for the time window or the [popularity floor](popularity-floor.md). They are named only as configuration.
- The spec does not say which searchers count as "eligible".

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-01
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-build](autocomplete-build.md)
- [click-log](click-log.md)
- [click-through-rate](click-through-rate.md)
- [distinct-searchers](distinct-searchers.md)
- [eligible-searcher](eligible-searcher.md)
- [event-id](event-id.md)
- [popularity-floor](popularity-floor.md)
- [query-snapshot](query-snapshot.md)
- [search-performed-event](search-performed-event.md)
<!-- used-by:end -->
