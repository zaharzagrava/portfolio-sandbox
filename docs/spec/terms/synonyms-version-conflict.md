---
id: synonyms-version-conflict
title: synonyms_version_conflict (409)
kind: term
status: draft
aliases: [synonyms_version_conflict]
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# synonyms_version_conflict (409)
## Definition
`synonyms_version_conflict` is the `409` error a synonym edit gets when its [`expectedVersion`](expected-version.md) is not the current [synonym rules version](synonym-rules-version.md). This is [optimistic concurrency ↗](../sw-external-terms.md#optimistic-concurrency-control): when two edits are sent with the same version, exactly one succeeds and the other gets this error. Any edit based on an old version also gets this error. The answer includes [`currentVersion`](version-conflict.md), so the admin can read the current rules again and redo the edit on top of them. Design intent (not stated in the spec): this stops one admin from silently overwriting another admin's edit.

## Example
Two admins both send `PUT /admin/search/synonyms` with `"expectedVersion": 7`. The first one succeeds and the version moves on. The second one gets:
```json
409 { "code": "synonyms_version_conflict", "currentVersion": 8 }
```
(The version numbers are illustrative.)

## Known gaps
- The spec does not say which check runs first when an edit is identical to the current rules but has an old `expectedVersion`. The answer could be `200` with [`unchanged: true`](synonyms-unchanged-flag.md) or this `409`.

## Used by
<!-- used-by:start -->
- [synonym-rules-version](synonym-rules-version.md)
<!-- used-by:end -->
