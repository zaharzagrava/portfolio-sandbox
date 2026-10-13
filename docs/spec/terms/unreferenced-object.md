---
id: unreferenced-object
title: Unreferenced object
kind: term
status: draft
aliases: [unreferenced objects]
defined_for: S33-autocomplete
rules_hash: 2b4ad23be2c3
---
# Unreferenced object
## Definition
An unreferenced object is a [snapshot object](snapshot.md) in [object storage ↗](../sw-external-terms.md#object-storage) whose version [the pointer](autocomplete-pointer.md) does not name and that is not one of the [kept published versions](published-version.md). The process that removes old objects does not delete an unreferenced object that is younger than a minimum age. Design intent (not stated in the spec): the age guard stops that process from deleting an object that a build in progress has just written but has not yet pointed to.

## Example
A build has uploaded [`autocomplete/<version>`](autocomplete-object.md) but has not moved the pointer yet. Retention runs at that moment. The object is less than one hour old, so it stays even though nothing references it.

## Known gaps
- The spec does not say how an object's age is measured (storage creation time or a timestamp in the snapshot).
- The spec does not say when old unreferenced objects are finally removed, or by which process.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-16
- [autocomplete-object](autocomplete-object.md)
- [autocomplete-pointer](autocomplete-pointer.md)
- [autocomplete-retention](autocomplete-retention.md)
- [published-version](published-version.md)
- [snapshot](snapshot.md)
<!-- used-by:end -->
