---
id: can-advance
title: canAdvance
kind: term
status: draft
aliases: []
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# canAdvance
## Definition
`canAdvance` is the domain check the [suggest builder](suggest-builder.md) runs before it moves the [version pointer](version-pointer.md). It decides whether a finished build's version is greater than the version the pointer names now. If it is not, the build does not publish. Instead it deletes its own snapshot object and ends [`superseded`](superseded-build.md). This check is why only the builder moves the pointer, and only forward. [Serving nodes](serving-node.md) do not use it: they follow the pointer wherever it points, including backwards when an operator sets it back.

## Example
Two builds overlap, and the older one finishes last. When the older build runs the check, its version is not greater than the pointer. It deletes its own [`autocomplete/<version>`](autocomplete-object.md) object and ends `superseded`. The pointer keeps the newer version.

## Known gaps
- The spec does not say how versions are generated or compared, so it does not define what "greater" means.
- Not confirmed in the code: the signature and return shape of `canAdvance` in `snapshot-pointer.ts`, or whether the check and the pointer write happen as one atomic conditional write. If they don't, a race between the check and the write is possible. Only the job's once-across-replicas lease would prevent it.

## Used by
<!-- used-by:start -->
- [serving-node](serving-node.md)
- [suggest-builder](suggest-builder.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
