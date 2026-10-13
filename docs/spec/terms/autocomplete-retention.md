---
id: autocomplete-retention
title: Autocomplete retention cleanup
kind: term
status: draft
aliases: [cleanup, retention]
defined_for: S33-autocomplete
rules_hash: e3b0c44298fc
---
# Autocomplete retention cleanup
## Definition
Retention cleanup removes old [snapshot objects](autocomplete-object.md) from [object storage ↗](../sw-external-terms.md#object-storage) so that only the most recent [published versions](published-version.md) stay. It never deletes the object that [the pointer](autocomplete-pointer.md) names. It also leaves alone any [unreferenced object](unreferenced-object.md) younger than a minimum age. Design intent (not stated in the spec): the age guard stops cleanup from deleting an object that an [in-progress build](autocomplete-build.md) has just written but not yet pointed to.

## Example
A sixth version is published. Cleanup deletes the oldest published `autocomplete/<version>`, so the latest five remain. The pointed version stays, even if an operator has set the pointer back to an older one. An unreferenced object that is 20 minutes old also stays (20 minutes is illustrative; the rule's minimum age is one hour).

## Known gaps
- The spec does not say which process runs cleanup (for example, the `search.build-autocomplete` job after it publishes) or when it runs.
- The spec does not say how an object's age is measured (storage creation time or a timestamp inside the snapshot).
- The spec does not say whether a pointed version that is older than the latest five counts as one of the kept five or is kept in addition to them.

## Used by
<!-- used-by:start -->
- [autocomplete-build](autocomplete-build.md)
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [published-version](published-version.md)
- [unreferenced-object](unreferenced-object.md)
<!-- used-by:end -->
