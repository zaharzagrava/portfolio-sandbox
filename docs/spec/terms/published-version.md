---
id: published-version
title: Published version
kind: term
status: draft
aliases: [version]
defined_for: S33-autocomplete
rules_hash: 3633c6cb87b2
---
# Published version
## Definition
A published version is a [snapshot](suggest-snapshot.md) that a successful build wrote to [object storage ↗](../sw-external-terms.md#object-storage) as [`autocomplete/<version>`](autocomplete-object.md) and then pointed the [version pointer](version-pointer.md) at. Serving nodes poll the pointer and load the version it names. Only a limited number of the latest published versions are kept. The version the pointer names is never deleted. Keeping older versions lets an [operator](operator.md) set the pointer back to one of them, and nodes then follow it.

## Example
After a sixth build publishes, storage holds only the latest five `autocomplete/<version>` objects. The one the pointer names is always among the objects kept.

## Known gaps
- The spec does not say which component deletes old versions, or when it runs (in the builder after publishing, or separately).
- The spec does not say whether the retention count can be configured.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-16
- [S52](../capabilities/S52-cache-toolkit.md): R-19
- [autocomplete-pointer](autocomplete-pointer.md)
- [autocomplete-retention](autocomplete-retention.md)
- [operator](operator.md)
- [suggest-snapshot](suggest-snapshot.md)
- [unreferenced-object](unreferenced-object.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
