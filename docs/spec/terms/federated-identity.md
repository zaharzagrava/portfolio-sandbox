---
id: federated-identity
title: FederatedIdentity
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# FederatedIdentity
## Definition
`FederatedIdentity` is the stored record of one identity link. It ties a user account to a [`(provider, subject)` pair](provider-subject.md). The [S02 capability](../capabilities/S02-mfa-oidc.md) owns this model. During the [OIDC callback](oidc-callback.md), the system looks up this record to find the user. A known subject signs in its linked user, whatever e-mail the provider now reports. The store lets an account hold at most one identity per provider. A user can list and [unlink](identity-link.md) only their own records.

## Example
A user is linked to Google subject `g-1`, so a `FederatedIdentity` exists for `(google, g-1)`. A Google login then arrives for subject `g-2` with that user's e-mail. The callback ends with [`error=link_conflict`](link-conflict.md) and creates no second record. `GET /auth/identities` lists only the caller's records, newest first. `DELETE /auth/identities/:identityId` removes one and emits `identity.federated_identity_unlinked`.

## Known gaps
- The spec does not say which fields `FederatedIdentity` stores beyond the provider, the subject and the linked user. For example, it does not say whether the e-mail at link time is kept. "Newest first" means a creation time exists, but its name is not given.
- The spec does not say whether unlinking is refused when the identity is the account's only way to sign in, such as a Google-created user with no password.
- Not confirmed in the code: how the store enforces "one identity per provider per account". A unique constraint is likely, but the facts do not name one.

## Used by
<!-- used-by:start -->
- [identity-link](identity-link.md)
- [oidc-callback](oidc-callback.md)
- [provider-subject](provider-subject.md)
<!-- used-by:end -->
