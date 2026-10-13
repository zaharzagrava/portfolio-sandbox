---
id: autocomplete-object
title: Autocomplete object
kind: term
status: draft
aliases: [autocomplete/<version>]
defined_for: S33-autocomplete
rules_hash: f003bd53dc79
---
# Autocomplete object
## Definition
The autocomplete object is one published snapshot, stored in [object storage ↗](../sw-external-terms.md#object-storage) under `autocomplete/<version>`. It holds only `{query, [searchers](distinct-searchers.md)}` pairs and the build parameters. It carries a [checksum](autocomplete-checksum.md). Decoding fails with a [typed reason](load-failure-reason.md) if the object is damaged. Serving nodes download the object that [the pointer](autocomplete-pointer.md) names and load it into memory as the [query index](query-index.md).

## Example
After a successful build, `autocomplete/<version>` exists and its checksum verifies (S33.B-14). When a sixth version is published, only the latest five remain. The pointed object is never deleted, and [unreferenced objects](unreferenced-object.md) younger than one hour stay (S33.B-16).

## Known gaps
- The spec does not name the encoding format of the object, or the typed failure reasons beyond "damaged or missing".
- The spec does not say which component deletes old objects (the builder or a separate job).

## Used by
<!-- used-by:start -->
- [autocomplete-checksum](autocomplete-checksum.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [autocomplete-retention](autocomplete-retention.md)
- [decode-snapshot](decode-snapshot.md)
- [load-failure-reason](load-failure-reason.md)
- [query-index](query-index.md)
- [superseded-build](superseded-build.md)
- [unreferenced-object](unreferenced-object.md)
<!-- used-by:end -->
