---
id: get-users-by-ids
title: getUsersByIds
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# getUsersByIds
## Definition
`getUsersByIds` is a user-directory lookup that [S01](../capabilities/S01-auth-sessions.md) offers to other domains. It takes a list of user IDs and returns a map of [user summaries](user-summary.md) for those IDs. IDs that are unknown or belong to [soft-deleted](soft-delete.md) users are left out of the map. The summaries carry no [secret fields](secret-fields.md).

## Example
Users A and B exist, C is soft-deleted, and `X` is an unknown ID:
```ts
getUsersByIds([A, B, C, X]) // the map holds only A and B, without secret fields
```

## Known gaps
- Not confirmed in the code: that `getUsersByIds` is a method of [`UserDirectoryService`](user-directory-service.md) in `packages/backend/libs/domains/identity/application/user-directory.service.ts`. The facts list that service as the user-directory export but do not name its methods.
- The spec does not say what the map is keyed by, or whether there is a limit on the number of IDs per call.

## Used by
<!-- used-by:start -->
- [secret-fields](secret-fields.md)
- [soft-delete](soft-delete.md)
- [user-directory-service](user-directory-service.md)
- [user-summary](user-summary.md)
<!-- used-by:end -->
