---
id: find-by-email
title: findByEmail
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# findByEmail
## Definition
`findByEmail` is a [user-directory lookup](user-directory-service.md) that [S01](../capabilities/S01-auth-sessions.md) offers to other domains. It finds one user by email address and returns that user's [summary](user-summary.md), or `null` when no account has that address. It trims and lower-cases the address before the lookup, the same way registration does, so spacing and letter case do not matter.

## Example
```ts
findByEmail(" A@Example.com ")   // returns A's summary (A is stored as a@example.com)
findByEmail("nobody@example.com") // returns null (illustrative address)
```

## Known gaps
- The spec does not say whether a [soft-deleted](soft-delete.md) user is returned or treated as unknown.
- Not confirmed in the code: that `findByEmail` belongs to [`UserDirectoryService`](user-directory-service.md), or that it calls `normalizeEmail`. The behavior only shows that the trimmed, lower-cased lookup works.

## Used by
<!-- used-by:start -->
- [soft-delete](soft-delete.md)
- [user-directory-service](user-directory-service.md)
- [user-summary](user-summary.md)
<!-- used-by:end -->
