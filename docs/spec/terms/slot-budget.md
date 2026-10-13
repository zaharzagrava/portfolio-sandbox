---
id: slot-budget
title: Slot budget
kind: term
status: draft
aliases: [slot, slots, unused slots]
defined_for: S33-autocomplete
rules_hash: c4376172c9f4
---
# Slot budget
## Definition
A slot budget is the number of places in one [`GET /suggest`](get-suggest.md) answer that the [suggestion blend](suggestion-blend.md) reserves for one [suggestion source](suggestion-source.md). Query suggestions get a fixed share of `limit`, rounded up. [Catalog completions](catalog-completions.md) get the remaining places, up to a fixed cap. If a source fills fewer places than its budget, it hands the unused ones to the other source. The code is `blendSuggestions` in `packages/backend/libs/domains/discovery/domain/suggestion-blend.ts`.

## Example
When `limit` is omitted, the default of 8 applies. Queries then get ⌈0.6 × 8⌉ = 5 slots and the catalog gets the other 3.
If the [query index](query-index.md) matches only 2 queries for `q=iph` (illustrative count), it hands its 3 unused slots to catalog completions.
In the other direction, if the catalog returns 1 title for `q=iph`, its 2 unused slots go to query suggestions.

## Known gaps
- The spec does not say how many slots the [typo source](typo-suggestion-source.md) gets, or whether it can receive unused slots.
- The spec does not say whether the catalog cap still applies after the catalog receives unused query slots.
- The spec does not say whether the query share or the catalog cap can be configured. The "budgets" setting listed under Configuration may mean time budgets per source instead.

## Used by
<!-- used-by:start -->
- [autocomplete-source-duration-seconds](autocomplete-source-duration-seconds.md)
- [blended-suggestions](blended-suggestions.md)
- [catalog-completions](catalog-completions.md)
- [failures-only-policy](failures-only-policy.md)
- [query-index](query-index.md)
- [suggest-limit](suggest-limit.md)
- [suggestion-blend](suggestion-blend.md)
- [suggestion-source](suggestion-source.md)
- [typo-suggestion-source](typo-suggestion-source.md)
<!-- used-by:end -->
