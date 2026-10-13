---
id: suggestion-blend
title: Suggestion blend
kind: term
status: draft
aliases: [blend]
defined_for: S33-autocomplete
rules_hash: a3da46523d06
---
# Suggestion blend
## Definition
The suggestion blend merges the answers from the separate producers of suggestions into the single list that [`GET /suggest`](get-suggest.md) returns. It removes duplicates by comparing a cleaned-up form of each text. When two producers offer the same text, the first one wins, in the order query, catalog, typo. The query-based suggestions and the [catalog completions](catalog-completions.md) each get a fixed number of places in the list, and a producer that doesn't fill its places hands the unused ones to the other. The code is `blendSuggestions` in `packages/backend/libs/domains/discovery/domain/suggestion-blend.ts`.

## Example
With the default `limit` of 8, queries get ⌈0.6 × 8⌉ = 5 slots. If the query index matches only 2 queries for `iph`, the 3 unused slots go to catalog completions. If the query `iphone case` and a catalog title both reduce to `iphone case`, only the `query` entry is kept.

## Known gaps
- The spec does not say how many slots the typo source gets, or whether it gets unused slots from the other sources.
- The spec does not say whether the catalog cap still applies after the catalog receives unused query slots.
- The spec does not say how entries from different sources are ordered in the final list. For example, it doesn't say whether all queries come before all catalog entries.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-09, R-10
- [catalog-completions](catalog-completions.md)
- [catalog-suggestion-source](catalog-suggestion-source.md)
- [catalog-title-source-adapter](catalog-title-source-adapter.md)
- [get-suggest](get-suggest.md)
- [normalised-text](normalised-text.md)
- [query-suggestion](query-suggestion.md)
- [query-suggestions](query-suggestions.md)
- [slot-budget](slot-budget.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggest-limit](suggest-limit.md)
- [suggest-ordering](suggest-ordering.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [suggestion-source](suggestion-source.md)
- [suggestion](suggestion.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
