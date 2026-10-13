---
id: suggest-publish
title: Publishing a snapshot
kind: term
status: draft
aliases: [published]
defined_for: S33-autocomplete
rules_hash: 2ce83f73083a
---
# Publishing a snapshot
## Definition
Publishing is the last step of a successful autocomplete build. The builder writes a new [snapshot object](suggest-snapshot.md) to [object storage ↗](../sw-external-terms.md#object-storage) and then moves the [version pointer](version-pointer.md) to that version. Serving nodes poll the pointer, so they load the new snapshot only after it is published. A build that ends [`unchanged`](build-end-states.md), `skipped_empty` or [`superseded`](build-end-states.md) does not publish. A `superseded` build also deletes the object it wrote.

## Example
The hourly job `search.build-autocomplete` finishes version `V2` (illustrative). The object `autocomplete/V2` now exists, the pointer reads `V2`, and the checksum verifies. Within one poll interval, each node [hot-swaps](hot-swap.md) to `V2`.

## Known gaps
- The spec does not say how a version is generated, or what makes one version "greater" than another.
- The spec does not say what a node sees if the builder crashes after writing the object but before moving the pointer. Unreferenced objects younger than one hour are kept, but nothing says when older ones are removed.
- The spec does not say whether the version pointer lives in object storage or in a different store.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): R-23
- [build-window](build-window.md)
- [hot-swap](hot-swap.md)
- [popularity-floor](popularity-floor.md)
- [suggest-index](suggest-index.md)
- [suggest-snapshot](suggest-snapshot.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
