---
id: build-end-states
title: Build end states
kind: term
status: draft
aliases: [skipped_empty, superseded, unchanged]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Build end states
## Definition
Every run of the [suggest builder](suggest-builder.md) ends in exactly one outcome: published, `unchanged`, `skipped_empty` or `superseded`. "Published" means it uploaded a new [suggest snapshot](suggest-snapshot.md) and moved the [version pointer](version-pointer.md) to it. `unchanged` means the entries are the same as the current snapshot, so nothing is published. `skipped_empty` means there were no [eligible queries](eligible-query.md), so nothing is published. `superseded` means the build's version is not greater than the pointer, so it deletes its own object.

## Example
Two builds overlap, and the older one finishes last. The pointer equals the newer version, and the older build's outcome is `superseded`.

## Known gaps
- The spec does not say whether [`autocomplete_build_total`](autocomplete-build-total.md) is labelled by these outcomes.
- The spec does not name an outcome for a build that fails with an error. The list covers only builds that complete.

## Used by
<!-- used-by:start -->
- [autocomplete-build-total](autocomplete-build-total.md)
- [eligible-query](eligible-query.md)
- [skipped-locked](skipped-locked.md)
- [suggest-builder](suggest-builder.md)
- [suggest-snapshot](suggest-snapshot.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
