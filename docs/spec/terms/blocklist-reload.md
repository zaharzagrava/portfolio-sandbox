---
id: blocklist-reload
title: Blocklist reload
kind: term
status: draft
aliases: [reloads]
defined_for: S33-autocomplete
rules_hash: 5ca33bdcc7fa
---
# Blocklist reload
## Definition
A blocklist reload is how a change to the [autocomplete blocklist](autocomplete-blocklist.md) reaches a running [serving node](worker-instance.md). The new list takes effect after a restart or a reload, without waiting for a new build. [Serve-time filtering](serve-time.md) covers suggestions already in the [loaded snapshot](suggest-snapshot.md) and also [catalog results](catalog-completions.md). Blocked entries therefore disappear before the [next build](autocomplete-build.md) runs.

## Example
`cheap` is added to the blocklist. The node is restarted, or the blocklist is reloaded. The next `GET /api/suggest?q=cheap` no longer returns `cheap iphone` or `Cheap iPhone Stand`, even though the snapshot still contains `cheap iphone`.

## Known gaps
- The spec does not say what triggers a reload without a restart, such as a signal, an endpoint or a poll. It also does not say whether the reloaded list is validated the same way as at startup.
- The spec does not say whether catalog results already cached per prefix are dropped on reload. Serve-time filtering suggests they are filtered on the way out, but this is not stated.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-07
- [autocomplete-blocklist](autocomplete-blocklist.md)
- [autocomplete-build](autocomplete-build.md)
- [catalog-completions](catalog-completions.md)
- [serve-time](serve-time.md)
- [suggest-snapshot](suggest-snapshot.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
