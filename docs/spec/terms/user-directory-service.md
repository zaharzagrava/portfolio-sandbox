---
id: user-directory-service
title: UserDirectoryService
kind: term
status: draft
aliases: [user-directory export, user-directory.service.ts]
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# UserDirectoryService
## Definition
`UserDirectoryService` is a service that [S01](../capabilities/S01-auth-sessions.md) exports so other domains can look up user accounts. Those domains can read user data without querying the `User` table themselves. Its lookups, such as fetching several users by their IDs or finding one user by email address, return [user summaries](user-summary.md) without [secret fields](secret-fields.md). Soft-deleted users are left out of the results. Design intent (not stated in the spec): S01 stays the only owner of `User`, and other domains depend on a narrow read interface.

## Example
Another domain needs the display data of the buyers on a page of orders:
```ts
getUsersByIds([A, B, C, unknown]) // C is soft-deleted → the map holds only A and B
findByEmail(" A@Example.com ")    // → A's summary; an unknown address → null
```

## Known gaps
- Not confirmed in the code: that getUsersByIds and findByEmail are methods of `UserDirectoryService` in `packages/backend/libs/domains/identity/application/user-directory.service.ts`. The facts name the service and the two lookups, but they never link the lookups to the service.
- The spec does not say which fields a user summary contains, or whether the service offers any lookups besides these two.
- The spec does not say how other domains get the service (for example, through module import and dependency injection), or whether calls are rate-limited or cached.

## Used by
<!-- used-by:start -->
- [find-by-email](find-by-email.md)
- [get-users-by-ids](get-users-by-ids.md)
- [secret-fields](secret-fields.md)
- [user-summary](user-summary.md)
<!-- used-by:end -->
