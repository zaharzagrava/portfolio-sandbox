---
id: typo-suggestion-source
title: Typo suggestion source
kind: term
status: draft
aliases: [typo]
defined_for: S33-autocomplete
rules_hash: b7d0f929d2ba
---
# Typo suggestion source
## Definition
The typo [suggestion source](suggestion-source.md) is the third suggestion source in the [blend](suggestion-blend.md). It offers typo-corrected product titles when the typed prefix may be misspelled. The page title calls it a "typo fallback". In the blend it has the lowest priority: if its text matches a suggestion based on what users have searched before or a [catalog completion](catalog-completions.md), the other entry wins.

## Example
Illustrative only: a buyer types `iphnoe`. The typo source might suggest a corrected title starting with `iphone`. If the catalog source already returned the same normalised text, the typo entry is dropped.

## Known gaps
- The spec does not say how typos are detected or corrected, or when this source runs (always, or only when the other sources return little).
- The spec does not say what [slot budget](slot-budget.md) it has, or what name it reports in [`degraded`](degraded.md) when it fails.
- Not confirmed in the code: no class or file for this source appears in the verified notes.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-09
- [blended-suggestions](blended-suggestions.md)
- [catalog-completions](catalog-completions.md)
- [query-suggestion](query-suggestion.md)
- [query-suggestions](query-suggestions.md)
- [slot-budget](slot-budget.md)
- [suggest-entry-kinds](suggest-entry-kinds.md)
- [suggest-limit](suggest-limit.md)
- [suggest-ordering](suggest-ordering.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-source](suggestion-source.md)
- [suggestion](suggestion.md)
<!-- used-by:end -->
