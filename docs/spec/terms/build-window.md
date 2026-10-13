---
id: build-window
title: Build window
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: 16857a208ea3
---
# Build window
## Definition
The build window is the stretch of recent [search log](search-log.md) that one [autocomplete build](autocomplete-build.md) reads. The hourly build counts [distinct searchers](distinct-searchers.md) per query using only searches inside this window. Its length is a configuration value and is checked when the service starts. Older searches drop out as the window moves, so suggestions follow what buyers search for now. That last point is design intent (not stated in the spec).

## Example
Say the build window is 7 days (an illustrative value). A query that many people searched 8 days ago, and nobody has searched since, gets no searchers in the next build. It is not [published again](suggest-publish.md).

## Known gaps
- The spec does not give the default length of the window or the name of its configuration key.
- The spec does not say whether the window ends at the time the build starts or at some other point, or which timestamp decides whether a search falls inside it.
- Not confirmed in the code: the spec names no code reference for how the window is applied.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-11, B-18
- [autocomplete-build](autocomplete-build.md)
- [co-order-threshold](co-order-threshold.md)
- [distinct-searchers](distinct-searchers.md)
- [order-baskets-build](order-baskets-build.md)
- [order-refunded-event](order-refunded-event.md)
- [recommendations-config](recommendations-config.md)
- [search-log](search-log.md)
- [suggest-publish](suggest-publish.md)
- [suggestion-build](suggestion-build.md)
<!-- used-by:end -->
