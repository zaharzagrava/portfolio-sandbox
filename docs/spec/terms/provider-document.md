---
id: provider-document
title: Provider document
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: d0c4563b367a
---
# Provider document
## Definition
The provider document is the configuration that the system fetches from an [OIDC provider's issuer](oidc-issuer.md) before it starts a flow. It describes that provider's endpoints and settings. The fetched document is kept between flows. Calling [`invalidate`](invalidate.md) for a provider makes the next flow fetch it again and use [the resolver's current settings](oidc-provider-resolver.md). An issuer that fails the [issuer checks](issuer-checks.md) (not `https`, a non-443 port, or a [loopback, private or link-local address ↗](../sw-external-terms.md#ssrf)) is refused with no outbound request, so no document is fetched.

## Example
A shop admin changes their enterprise provider settings, and S03 calls `invalidate` for that provider. The next `POST /auth/oidc/:provider/start` fetches the provider document again, and the `authorizationUrl` it returns reflects the new settings.

## Known gaps
- Not confirmed in the code: that this is the standard OIDC discovery document (`/.well-known/openid-configuration`), or which fields the system reads from it.
- The spec does not say how long a fetched document is kept without an `invalidate`, or what a failed fetch answers. `503 oidc_provider_unavailable` is only specified for a resolver that throws.
- The spec does not say whether the static Google provider's document is cached and invalidated the same way as documents for resolver-supplied providers.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-25
- [issuer-checks](issuer-checks.md)
- [oidc-issuer](oidc-issuer.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
<!-- used-by:end -->
