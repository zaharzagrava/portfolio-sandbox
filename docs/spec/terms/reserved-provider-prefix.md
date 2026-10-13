---
id: reserved-provider-prefix
title: Reserved provider prefix
kind: term
status: draft
aliases: [reserved prefix]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# Reserved provider prefix
## Definition
A reserved provider prefix is the start of a provider id that a domain has claimed in the [`OidcProviderRegistry`](oidc-provider-registry.md). [S02](../capabilities/S02-mfa-oidc.md) sends every provider id with that prefix to the claiming domain's resolver instead of looking it up among the fixed, preconfigured providers. [S03](../capabilities/S03-shops-rbac.md) claims a prefix for its [per-shop dynamic providers](dynamic-provider.md). Design intent (not stated in the spec): the prefix keeps shop provider ids apart from fixed provider ids like Google's, so the two can never collide.

## Example
Say S03 has reserved the prefix `sso-` (illustrative, the real value is not in the spec). Then `POST /auth/oidc/sso-acme/start` (illustrative) is resolved through S03, while `POST /auth/oidc/google/start` is read from static configuration.

## Known gaps
- The spec does not say what the reserved prefix is or which characters it uses.
- The spec does not say whether a static provider id may begin with a reserved prefix, or how such a clash is caught.
- The spec does not say whether [`GET /auth/oidc/providers`](get-auth-oidc-providers.md) ever lists ids with a reserved prefix. It lists only enabled static providers.

## Used by
<!-- used-by:start -->
- [dynamic-provider](dynamic-provider.md)
- [oidc-provider-registry](oidc-provider-registry.md)
- [static-provider-configuration](static-provider-configuration.md)
<!-- used-by:end -->
