---
id: oidc-issuer
title: OIDC issuer
kind: term
status: draft
aliases: [issuer]
defined_for: S02-mfa-oidc
rules_hash: 9bb8d13ed923
---
# OIDC issuer
## Definition
The OIDC issuer is the base address of an [OIDC provider](oidc-provider-registry.md) and identifies that provider. The system fetches the provider document from the issuer before it starts a flow. During the [OIDC callback](oidc-callback.md), the [ID token's `iss` ↗](../sw-external-terms.md#jwt-iss) must name the same issuer, or the login fails with a [closed error code](closed-error-code.md). Before the system contacts an issuer, the address must pass the [issuer checks](issuer-checks.md).

## Example
An enterprise provider supplied through the [OidcProviderRegistry](oidc-provider-registry.md) has the issuer `https://login.acme-corp.example` (illustrative). `POST /auth/oidc/:provider/start` fetches the provider document from that address. If the ID token later comes back with a different `iss`, the callback ends the login with no session.

## Known gaps
- The spec does not say where a [resolver-supplied](oidc-provider-resolver.md) provider's issuer is set, for example which member of the settings object holds it.
- The spec does not say whether the static Google provider's issuer also goes through the issuer checks, or only issuers from a resolver.
- Not confirmed in the code: how strictly `iss` is compared with the issuer, for example whether a trailing `/` counts as a difference.

## Used by
<!-- used-by:start -->
- [closed-error-code](closed-error-code.md)
- [issuer-checks](issuer-checks.md)
- [oidc-callback](oidc-callback.md)
- [oidc-provider-registry](oidc-provider-registry.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
- [provider-document](provider-document.md)
- [put-shops-sso](put-shops-sso.md)
<!-- used-by:end -->
