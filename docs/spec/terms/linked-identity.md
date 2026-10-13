---
id: linked-identity
title: Linked identity
kind: term
status: draft
aliases: [explicit linking, identities, linked user]
defined_for: S02-mfa-oidc
rules_hash: 7f39077ccc94
---
# Linked identity
## Definition
A linked identity is a [`FederatedIdentity`](federated-identity.md) record that ties one account at an outside sign-in service, identified by that service's name and its fixed ID for the account, to one user. A login with an account that is already known signs in that user, whatever e-mail the service reports now. Users can list only their own linked identities, newest first. They can also unlink one. [Unlinking](identity-link.md) someone else's identity, or an unknown one, gives [the same not-found answer](identical-not-found.md).

## Example
`GET /auth/identities` returns the caller's identities, for example one Google identity with subject `g-1`.
`DELETE /auth/identities/:identityId` with another user's id answers [`404 identity_not_found`](identity-not-found.md).

## Known gaps
- The spec does not list the fields in the list response.
- The spec does not say whether the system refuses to unlink the only way a Google-created user (who has no password) can sign in.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-19, B-20
- [caller-scoping](caller-scoping.md)
- [identical-not-found](identical-not-found.md)
- [identity-link](identity-link.md)
- [link-conflict](link-conflict.md)
- [oidc-account-link](oidc-account-link.md)
- [passwordless-account](passwordless-account.md)
- [provider-subject](provider-subject.md)
- [soft-deleted-user](soft-deleted-user.md)
<!-- used-by:end -->
