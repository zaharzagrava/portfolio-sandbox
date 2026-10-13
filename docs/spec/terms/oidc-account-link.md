---
id: oidc-account-link
title: OIDC account link
kind: term
status: draft
aliases: [link, linked]
defined_for: S02-mfa-oidc
rules_hash: f5fc7fad76dd
---
# OIDC account link
## Definition
An OIDC account link connects an account to a provider identity, which is a [`(provider, subject)` pair](provider-subject.md). After linking, a Google login with that subject signs in that account. A link is created in one of three ways:
- **New user:** [the callback](oidc-callback.md) creates a new user for an unknown subject and e-mail.
- **Verified e-mail:** the callback links an existing account when the provider reports [`email_verified`](email-verified.md) as the boolean `true`.
- **[Explicit linking](linked-identity.md):** a signed-in user starts linking on purpose.

Linking by e-mail also turns the account's [second factor](mfa-state.md) off. [Dynamic providers](dynamic-provider.md) from S03 are never linked by e-mail.

## Example
A password account for `ana@example.com` (illustrative) has never used Google. A Google login arrives with that e-mail verified. The callback signs in the same user and stores a [`FederatedIdentity`](federated-identity.md). It also emits `identity.federated_identity_linked`.

## Known gaps
- The spec does not say why linking by e-mail moves the second factor from `enabled` to `none`. One likely reason: the provider's verification takes the place of the old factor. That is design intent (not stated in the spec).
- The spec does not say whether the user is told that their second factor was removed.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-31, B-19
- [S03](../capabilities/S03-shops-rbac.md): B-21
- [dynamic-provider](dynamic-provider.md)
- [email-not-verified](email-not-verified.md)
- [linked-identity](linked-identity.md)
- [linked-query-param](linked-query-param.md)
- [mfa-state](mfa-state.md)
- [oidc-callback](oidc-callback.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
- [provider-subject](provider-subject.md)
<!-- used-by:end -->
