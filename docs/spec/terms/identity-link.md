---
id: identity-link
title: Identity link (linking)
kind: term
status: draft
aliases: [identity, linked, unlinking]
defined_for: S02-mfa-oidc
rules_hash: e286cb1db487
---
# Identity link (linking)
## Definition
Linking attaches an external Google identity, stored as a [`FederatedIdentity`](linked-identity.md), to an account, so that Google sign-in opens that account. It can happen when a first Google login creates a new user, or when a callback links by e-mail because the provider reports [`email_verified`](email-verified.md) as the boolean `true`. A signed-in user can also link explicitly through `POST /auth/oidc/:provider/link/start`. Linking by e-mail moves the [second factor](mfa-state.md) from [`enabled`](mfa-state.md) to `none`. Providers added at runtime from S03 never link by e-mail.

## Example
A password account with the e-mail of a Google login that has `email_verified: true` gets signed in and linked (S02.B-15). An explicit link instead redirects with [`?linked=google`](linked-query-param.md) and issues no new session (S02.B-19). Both emit `identity.federated_identity_linked`.

## Known gaps
- The spec does not say why linking by e-mail moves the second factor to `none`. It states the transition but gives no reason.
- The spec does not say what the user sees when an e-mail link turns off their second factor.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-21, R-23
- [dynamic-provider](dynamic-provider.md)
- [federated-identity](federated-identity.md)
- [identity-not-found](identity-not-found.md)
- [identity-store](identity-store.md)
- [link-conflict](link-conflict.md)
- [linked-identity](linked-identity.md)
- [mfa-state](mfa-state.md)
- [provider-subject](provider-subject.md)
<!-- used-by:end -->
