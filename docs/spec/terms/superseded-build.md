---
id: superseded-build
title: superseded (build outcome)
kind: term
status: draft
aliases: [superseded]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# superseded (build outcome)
## Definition
`superseded` is one of the four outcomes a [query index build](query-index-build.md) can end in. A build ends this way when its version is not greater than the [version pointer](version-pointer.md) at the moment it tries to publish. Usually that means a newer build already moved the pointer. The superseded build deletes its own [snapshot object](autocomplete-object.md) and leaves the pointer alone. This way the pointer only ever moves forward in the builder.

## Example
Build A starts with version `V1` and build B starts later with `V2`. B finishes first and moves the pointer to `V2`. When A finishes, [`canAdvance`](can-advance.md) refuses because `V1` is not greater than `V2`. A deletes `autocomplete/V1` and ends `superseded`. (Version names are illustrative.)

## Known gaps
- The spec does not say how build versions are generated or compared (for example, a timestamp or a counter).
- The spec does not say whether an [operator](operator.md) who sets the pointer back makes later builds end `superseded`. Nodes do follow a pointer that was set back (S33.R-24).

## Used by
<!-- used-by:start -->
- [autocomplete-object](autocomplete-object.md)
- [operator](operator.md)
- [query-index-build](query-index-build.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
