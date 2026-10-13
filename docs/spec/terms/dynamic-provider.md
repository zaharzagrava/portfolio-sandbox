---
id: dynamic-provider
title: Dynamic provider
kind: term
status: draft
aliases: [dynamic providers]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# Dynamic provider
## Definition
A dynamic provider is a per-shop enterprise identity provider that the shop sign-in service supplies at runtime instead of through static configuration. That service registers a resolver for a set-aside id prefix in the [`OidcProviderRegistry`](oidc-provider-registry.md), so any provider id starting with that prefix is resolved through it. Dynamic providers are trusted for the subject only and never link by e-mail, whatever the ID token's [`email_verified`](email-verified.md) says. Design intent (not stated in the spec): each shop configures its own issuer, so its e-mail claims cannot be trusted to match accounts across the whole platform.

## Example
A shop's enterprise provider, registered under the reserved prefix, returns `{ "sub": "emp-42", "email": "ana@example.com", "email_verified": true }` (illustrative values).
- If `(provider, emp-42)` is already linked, the linked user is signed in.
- If it is not linked, the token is **not** matched to an existing password account with `ana@example.com`. Google, a static provider, would match it.

## Known gaps
- The spec does not say what the reserved prefix is, or how the callback ends when a dynamic provider's subject is not linked yet. It could create a user or return an error.
- The spec does not say whether dynamic providers appear in `GET /auth/oidc/providers`, which lists the enabled static providers.
- Not confirmed in the code: the spec's known gaps say the registry, subject-only trust and the [SSRF guard ↗](../sw-external-terms.md#ssrf) for shop issuers have no test with a scenario id (AS-56 to AS-58).

## Used by
<!-- used-by:start -->
- [email-verified](email-verified.md)
- [get-auth-oidc-providers](get-auth-oidc-providers.md)
- [identity-link](identity-link.md)
- [linked-query-param](linked-query-param.md)
- [oidc-account-link](oidc-account-link.md)
- [provider-subject](provider-subject.md)
- [reserved-provider-prefix](reserved-provider-prefix.md)
- [static-provider-configuration](static-provider-configuration.md)
<!-- used-by:end -->
