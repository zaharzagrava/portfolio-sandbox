---
id: static-provider-configuration
title: Static provider configuration
kind: term
status: draft
aliases: [static ids, static providers]
defined_for: S02-mfa-oidc
rules_hash: 640086b92edc
---
# Static provider configuration
## Definition
Static provider configuration is the set of [OIDC providers ↗](../sw-external-terms.md#oidc) that the application defines in its own configuration. Another domain does not register them at run time. In S02 this means Google: its client settings, redirect URI and front-end origin are validated in `config-rules.ts`. Provider ids that have no [reserved provider prefix](reserved-provider-prefix.md) are looked up here. [OIDC start](oidc-start.md) answers `404 oidc_provider_not_found` for a provider that is unknown here or not configured.

Static providers differ from [dynamic provider](dynamic-provider.md)s in one important way. A dynamic provider is trusted for the subject only and never links by e-mail. A static provider may link by e-mail when [`email_verified`](email-verified.md) is the boolean `true`.

## Example
When Google is configured, `POST /auth/oidc/google/start` returns an `authorizationUrl` with [PKCE ↗](../sw-external-terms.md#pkce) and sets a [flow cookie](oidc-flow-cookie.md). The provider id `google` here is illustrative; the spec shows it only in `?linked=google`. If the Google client settings are missing, the same call answers `404 oidc_provider_not_found`.

## Known gaps
- The spec does not say which configuration keys hold the Google client settings, or what makes a static provider "enabled".
- The spec does not say whether providers other than Google can be configured statically.
- Not confirmed in the code: what `config-rules.ts` does with an incomplete Google configuration. It might refuse to start, or it might leave the provider disabled.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-24
- [dynamic-provider](dynamic-provider.md)
- [get-auth-oidc-providers](get-auth-oidc-providers.md)
- [oidc-flow-cookie](oidc-flow-cookie.md)
- [oidc-start](oidc-start.md)
- [reserved-provider-prefix](reserved-provider-prefix.md)
<!-- used-by:end -->
