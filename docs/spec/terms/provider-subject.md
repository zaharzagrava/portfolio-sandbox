---
id: provider-subject
title: (provider, subject) pair
kind: term
status: draft
aliases: [provider subject]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# (provider, subject) pair
## Definition
The `(provider, subject)` pair is the key of an [external identity](identity-link.md). It names the provider, such as Google, and the stable user identifier that provider issues (the [`sub` claim ↗](../sw-external-terms.md#jwt-sub) of the [ID token ↗](../sw-external-terms.md#oidc-id-token)). A login for a known pair signs in the linked user, even if the provider now reports a different e-mail. The e-mail only matters when no link exists for the pair yet. For [dynamic providers](dynamic-provider.md) from S03, the pair is the only thing trusted.

## Example
A user is linked to Google subject `g-1`. A login arrives for `g-1` carrying a new e-mail address, and the same user is signed in (S02.R-22). A login for `g-2` with that user's e-mail fails with [`error=link_conflict`](link-conflict.md) (S02.B-17).

## Known gaps
- The spec does not say whether the store enforces a unique `(provider, subject)` pair. It only says that two concurrent first logins for one subject end with one user and one link (S02.B-16).
- The spec does not say what the provider value looks like for dynamic S03 providers, beyond their use of a reserved provider prefix.

## Used by
<!-- used-by:start -->
- [dynamic-provider](dynamic-provider.md)
- [federated-identity](federated-identity.md)
- [identity-link](identity-link.md)
- [identity-store](identity-store.md)
- [link-conflict](link-conflict.md)
- [linked-identity](linked-identity.md)
- [oidc-account-link](oidc-account-link.md)
<!-- used-by:end -->
