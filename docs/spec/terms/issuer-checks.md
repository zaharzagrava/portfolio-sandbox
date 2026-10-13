---
id: issuer-checks
title: Issuer checks
kind: term
status: draft
aliases: [issuer check]
defined_for: S02-mfa-oidc
rules_hash: 7b32d1fc8deb
---
# Issuer checks
## Definition
Issuer checks are the tests an OIDC issuer address must pass before the system makes any outbound request to it. The issuer must use `https` on the allowed port. It must not resolve to a [loopback, private or link-local address ↗](../sw-external-terms.md#ssrf). An issuer that fails a check gets the same [`404 oidc_provider_not_found`](oidc-provider-not-found.md) as an unknown provider. Nothing is fetched. Design intent (not stated in the spec): a provider's settings must not be able to make the backend call internal hosts.

## Example
[A resolver](oidc-provider-resolver.md) returns a provider whose issuer is `https://idp.acme-corp.example:8443` (illustrative). That port is not 443, so [`POST /auth/oidc/:provider/start`](oidc-start.md) answers `404 oidc_provider_not_found`. No request goes out. The same happens for `http://idp.acme-corp.example`, or for a hostname that resolves to `10.0.0.5` (illustrative).

## Known gaps
- The spec does not say whether the checks run only at OIDC start or also before later calls such as the [token exchange](token-exchange.md).
- Not confirmed in the code: whether the checked address is pinned for the real connection. If it isn't, a hostname that resolves differently between the check and the request (DNS rebinding) could slip past.
- The spec does not say whether a failed check is logged or counted separately from an ordinary unknown provider. The caller cannot tell them apart.

## Used by
<!-- used-by:start -->
- [oidc-issuer](oidc-issuer.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
- [provider-document](provider-document.md)
- [token-exchange](token-exchange.md)
<!-- used-by:end -->
