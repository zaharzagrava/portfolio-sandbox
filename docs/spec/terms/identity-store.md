---
id: identity-store
title: Identity store
kind: term
status: draft
aliases: [store]
defined_for: S02-mfa-oidc
rules_hash: f52c5d706c58
---
# Identity store
## Definition
The identity store is the persistence that holds [`FederatedIdentity`](linked-identity.md) records, meaning the links between accounts and [external identities](identity-link.md). It enforces the rule that one account holds at most one identity per [provider](provider-subject.md). The store itself enforces that rule, not only application code, so concurrent requests cannot get around it. Design intent (not stated in the spec): this protects against [races ↗](../sw-external-terms.md#race-condition) between [concurrent callbacks](oauth-callback.md).

## Example
A user already linked to Google subject `g-1` cannot get a second Google identity. A login for `g-2` with the user's e-mail ends with [`error=link_conflict`](link-conflict.md) (S02.B-17, S02 AS-46, S02 AS-53).

## Known gaps
- Not confirmed in the code: the table name, or the mechanism that enforces one identity per provider (for example, a unique constraint).

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-23
- [identity-link](identity-link.md)
- [link-conflict](link-conflict.md)
- [oauth-callback](oauth-callback.md)
- [provider-subject](provider-subject.md)
<!-- used-by:end -->
