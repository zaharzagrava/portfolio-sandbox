---
id: suggestion-blocklist
title: Suggestion blocklist
kind: term
status: draft
aliases: [blocklist]
defined_for: S33-autocomplete
rules_hash: 67565b50a3c9
---
# Suggestion blocklist
## Definition
The suggestion blocklist is a configured list of terms that must never appear in suggestions, and it is validated at startup. It is applied twice: when the service answers a request, to every suggestion from every source (query, catalog, typo), and to the input used to produce the suggestion data. A change takes effect after a service restart or reload, without waiting for that data to be produced again. Blocked entries are dropped silently and are not reported in [`degraded`](degraded.md).

## Example
The [published query](published-query.md) `cheap iphone` and the visible product `Cheap iPhone Stand` both exist. After `cheap` is added to the blocklist and the service reloads it, neither appears for any prefix (S33.B-07).

## Known gaps
- The spec does not say how a term matches (substring, whole word or token). It also does not say whether matching happens on [reduced text](reduced-prefix.md). The example suggests case-insensitive matching.
- The spec does not say how a reload is triggered without a restart.
- The spec does not say whether the [blend](suggestion-blend.md) fills slots freed by blocked entries, so an answer may hold fewer than `limit` suggestions.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-17
- [catalog-completions](catalog-completions.md)
- [eligible-query](eligible-query.md)
- [published-query](published-query.md)
- [query-index-build](query-index-build.md)
- [reduced-prefix](reduced-prefix.md)
- [serve-time](serve-time.md)
- [suggest-builder](suggest-builder.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-build](suggestion-build.md)
- [suggestion-source](suggestion-source.md)
- [suggestion](suggestion.md)
<!-- used-by:end -->
