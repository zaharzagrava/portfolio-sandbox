---
id: oidc-provider-registry
title: OidcProviderRegistry
kind: term
status: draft
aliases: [registry]
defined_for: S02-mfa-oidc
rules_hash: 455ad194ce5d
---
# OidcProviderRegistry
## Definition
`OidcProviderRegistry` is the place in the [identity domain](identity-domain.md) where another domain can plug in its own [OIDC providers ↗](../sw-external-terms.md#oidc). A domain registers a resolver for a [reserved provider prefix](reserved-provider-prefix.md). When a provider id carries that prefix, [S02](../capabilities/S02-mfa-oidc.md) asks the resolver for the provider instead of using static configuration. [S03](../capabilities/S03-shops-rbac.md) uses the registry to supply dynamic providers. Design intent (not stated in the spec): other domains can add providers without the identity domain depending on them.

## Example
The registry lives in `packages/backend/libs/domains/identity/application/oidc-provider-registry.ts`. At startup S03 registers a resolver for its prefix. Later, `POST /auth/oidc/<prefix>…/start` goes to that resolver, while Google is still read from static configuration.

## Known gaps
- The spec does not say what the registration method or the resolver interface looks like, or what happens if two domains register the same prefix.
- The spec does not say whether an unknown id under a registered prefix answers `404 oidc_provider_not_found`, as unknown static providers do.
- Not confirmed in the code: the spec's known gaps say the registry has no test with a scenario id (AS-56).

## Used by
<!-- used-by:start -->
- [auth-oidc-enabled](auth-oidc-enabled.md)
- [identity-domain](identity-domain.md)
- [reserved-provider-prefix](reserved-provider-prefix.md)
<!-- used-by:end -->
