---
id: serve-time
title: Serve time
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: 4e875b341d08
---
# Serve time
## Definition
Serve time is the moment a node answers a [`GET /suggest`](get-suggest.md) request. Build time is when the hourly suggestion build produces a [snapshot](suggest-snapshot.md). Work done at serve time uses the current configuration and the snapshot loaded right now. [Blocklist filtering](suggestion-blocklist.md) runs at serve time, so a newly blocked query disappears even if an older snapshot still contains it. Design intent (not stated in the spec): this lets [operators](operator.md) remove a bad suggestion quickly without waiting for the next hourly build.

## Example
Snapshot `V1` contains `cheap iphone`. An operator adds `cheap` to the blocklist and the service reloads it. The next `GET /api/suggest?q=chea` leaves out `cheap iphone`, even though `V1` is unchanged.

## Known gaps
- The spec does not say how serve-time filtering interacts with the shared cache. A [`public, max-age=60` ↗](../sw-external-terms.md#cache-control) answer cached before the blocklist change may still be served by a shared cache until it expires.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-18
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [blocklist-reload](blocklist-reload.md)
- [catalog-completions](catalog-completions.md)
- [category-tracking](category-tracking.md)
- [operator](operator.md)
- [suggest-snapshot](suggest-snapshot.md)
- [suggestion-blocklist](suggestion-blocklist.md)
- [suggestion](suggestion.md)
<!-- used-by:end -->
