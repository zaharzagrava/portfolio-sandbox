---
id: user-summary
title: User summary
kind: term
status: draft
aliases: [summary]
defined_for: S01-auth-sessions
rules_hash: d85dc60626ba
---
# User summary
## Definition
A user summary is the reduced view of a user that the service in charge of looking up users gives to [other domains](orders-domain.md). [`findByEmail`](find-by-email.md) returns one summary, and [`getUsersByIds`](get-users-by-ids.md) returns a map of them. A summary never contains sensitive data such as password hashes or tokens. [Soft-deleted](soft-delete.md) users get no summary at all.

## Example
`findByEmail(" A@Example.com ")` returns A's summary. `getUsersByIds([A, B, C])` returns summaries for A and B only, because C is soft-deleted.

## Known gaps
- The spec does not say which fields a user summary contains (for example, whether it includes the role or the address).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-16
- [find-by-email](find-by-email.md)
- [get-users-by-ids](get-users-by-ids.md)
- [orders-domain](orders-domain.md)
- [secret-fields](secret-fields.md)
- [soft-delete](soft-delete.md)
- [user-directory-service](user-directory-service.md)
<!-- used-by:end -->
