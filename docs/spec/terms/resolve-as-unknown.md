---
id: resolve-as-unknown
title: Resolve as unknown
kind: term
status: draft
aliases: [unknown provider]
defined_for: S03-shops-rbac
rules_hash: 0ec5e1503b97
---
# Resolve as unknown
## Definition
"Resolve as unknown" is how the [sign-in registry](oidc-provider-registry.md) treats some [shop identity providers](oidc-provider-resolver.md) during a login. For these providers it behaves as if the shop had no provider at all. This applies to a disabled provider, a shop that is not [`ACTIVE`](shop-status.md), and a [sandbox shop](sandbox-shop.md). The [client secret](secret-fields.md) is not [unsealed](secret-box.md) in those cases. Answering "unknown" stops logins into shops that cannot be used. It probably also avoids telling outsiders why a login failed. That reason is design intent (not stated in the spec).

## Example
Shop `acme` (illustrative) is `SUSPENDED` but still has an [SSO configuration](shop-sso-config.md). A user starts company sign-in for `acme`. The registry resolves the provider as unknown, so the login cannot go ahead through that provider.

## Known gaps
- The spec does not say which error or [OIDC login error code](oidc-login-error.md) the user sees when a provider resolves as unknown.
- The spec does not say whether [`GET /shops/by-slug/:slug/sso`](shop-sso-lookup.md) also reports "no company sign-in" for these shops.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-22
- [delete-shop-sso](delete-shop-sso.md)
- [oidc-login-error](oidc-login-error.md)
- [oidc-provider-registry](oidc-provider-registry.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
- [sandbox-shop](sandbox-shop.md)
- [secret-box](secret-box.md)
- [secret-fields](secret-fields.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
