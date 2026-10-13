---
id: oidc-provider-resolver
title: OIDC provider resolver
kind: term
status: draft
aliases: [resolver]
defined_for: S02-mfa-oidc
rules_hash: 9426a254aa14
---
# OIDC provider resolver
## Definition
An OIDC provider resolver is a function that another domain registers in the [`OidcProviderRegistry`](oidc-provider-registry.md) for a [reserved provider prefix](reserved-provider-prefix.md). When a provider id with that prefix arrives, the resolver supplies the provider's settings. This is how S03 adds [per-shop enterprise identity providers](shop-sso-config.md) without code in S02. The registry refuses a prefix that is empty, that clashes with `google`, or that overlaps a prefix already registered. The system trusts a resolved provider for its subject only: its logins create accounts with [`email = null`](passwordless-account.md) and [never link to existing accounts by e-mail](oidc-account-link.md).

## Example
S03 registers a resolver for an illustrative prefix `shop-`. A call to `POST /auth/oidc/shop-acme/start` then asks that resolver for the provider's settings, including its issuer. If the resolver throws, the answer is `503 oidc_provider_unavailable`. If it returns a malformed settings object, the answer is `404 oidc_provider_not_found`.

## Known gaps
- The spec does not say which prefix S03 actually registers, or what shape the settings object has.
- The spec does not say whether resolver results are cached, or whether a call to a resolver has a timeout.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-31
- [issuer-checks](issuer-checks.md)
- [oidc-account-link](oidc-account-link.md)
- [oidc-issuer](oidc-issuer.md)
- [oidc-provider-not-found](oidc-provider-not-found.md)
- [oidc-provider-unavailable](oidc-provider-unavailable.md)
- [provider-document](provider-document.md)
- [reserved-provider-prefix](reserved-provider-prefix.md)
- [resolve-as-unknown](resolve-as-unknown.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
