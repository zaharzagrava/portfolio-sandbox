---
id: autocomplete-blocklist
title: Autocomplete blocklist
kind: term
status: draft
aliases: [blocklist]
defined_for: S33-autocomplete
rules_hash: 89180e15ee83
---
# Autocomplete blocklist
## Definition
The autocomplete blocklist is a configured list of terms that must never appear in [suggestions](query-suggestions.md). It is checked at [serve time](serve-time.md) against every suggestion from every source: queries, catalog titles and typo-corrected titles. The [offline build](autocomplete-build.md) also checks it, so blocked queries never enter a new [snapshot](query-snapshot.md). The check is done by `containsBlocked`. The blocklist is part of the autocomplete configuration and is validated at startup.

## Example
`cheap iphone` is published in the snapshot, and a visible product is titled `Cheap iPhone Stand`. An [operator](operator.md) adds `cheap` to the blocklist and the service reloads it. After that, `GET /api/suggest?q=chea` returns neither entry, and no new build is needed (S33.B-07).

## Known gaps
- The spec does not say how a term is matched against a suggestion: as a whole word, as a substring, or after normalisation. The example only shows that `cheap` blocks `Cheap iPhone Stand`.
- The spec does not say where the blocklist is stored or what format it uses. It only says it is part of the configuration.
- Not confirmed in the code: how `containsBlocked` handles case and Unicode folding.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-07
- [autocomplete-build](autocomplete-build.md)
- [blocklist-reload](blocklist-reload.md)
- [eligible-searcher](eligible-searcher.md)
- [operator](operator.md)
- [query-log](query-log.md)
- [query-snapshot](query-snapshot.md)
- [query-suggestions](query-suggestions.md)
- [serve-time](serve-time.md)
<!-- used-by:end -->
