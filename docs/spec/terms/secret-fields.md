---
id: secret-fields
title: Secret fields
kind: term
status: draft
aliases: [secret field]
defined_for: S01-auth-sessions
rules_hash: d35627c9c64f
---
# Secret fields
## Definition
Secret fields are the parts of a user record that must never leave [S01](../capabilities/S01-auth-sessions.md) through the lookups other domains use to fetch user details. [User summaries](user-summary.md) returned to other domains do not include them. Design intent (not stated in the spec): this keeps credential material inside the identity domain, so other services cannot leak it or misuse it.

## Example
[`getUsersByIds([A, B])`](get-users-by-ids.md) returns summaries for A and B. Neither summary contains secret fields. In general engineering practice the stored [password hash](password-hash.md) is the typical example of such a field (illustrative: the facts do not list it).

## Known gaps
- The spec does not say which fields count as secret.
- Not confirmed in the code: how the secret fields are left out of a summary (for example, a field allowlist or a separate type).

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): B-15
- [get-users-by-ids](get-users-by-ids.md)
- [password-hash](password-hash.md)
- [user-directory-service](user-directory-service.md)
- [user-summary](user-summary.md)
<!-- used-by:end -->
