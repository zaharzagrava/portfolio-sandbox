---
id: actor-id
title: actorId
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# actorId
## Definition
`actorId` is a field of the [audit line](audit-log.md) that every successful synonym edit writes, next to [`version`](synonym-rules-version.md) and [`ruleCount`](synonym-rule-count.md). It records who made the edit. Only a caller with the [administrator role](platform-admin.md) can reach [`PUT /admin/search/synonyms`](put-admin-search-synonyms.md), so this is the administrator who sent the edit. With it, an operator can trace each synonym version back to a person.

## Example
An administrator sends `PUT /admin/search/synonyms` with `{ "rules": ["sofa, couch"], "expectedVersion": 7 }`, and the edit succeeds. The audit line written is:
```json
{ "actorId": "<adminId>", "version": 8, "ruleCount": 1 }
```
(The values are illustrative.)

## Known gaps
- The spec does not say what form `actorId` takes, for example a user id or some other identifier.
- The spec does not say whether `actorId` holds the same value as `updatedBy`, which `GET /admin/search/synonyms` returns.
- The spec does not say whether failed or [`unchanged: true`](synonyms-unchanged-flag.md) edits write an audit line with an `actorId`. It only names successful edits.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [platform-admin](platform-admin.md)
<!-- used-by:end -->
