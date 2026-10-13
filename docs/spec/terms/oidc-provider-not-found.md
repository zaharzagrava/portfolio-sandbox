---
id: oidc-provider-not-found
title: oidc_provider_not_found (404)
kind: term
status: draft
aliases: [oidc_provider_not_found]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# oidc_provider_not_found (404)
## Definition
`oidc_[provider](oidc-provider-registry.md)_not_found` is the `404` answer when the requested provider cannot be used. It covers a provider that is unknown, malformed, unconfigured or disabled. It also covers a [resolver](oidc-provider-resolver.md) that returned malformed settings, and an [issuer ↗](../sw-external-terms.md#jwt-iss) that fails the address checks: not `https`, not port 443, or resolving to a [loopback, private or link-local address ↗](../sw-external-terms.md#ssrf). In the issuer case no outbound request is made. All of these give the same answer, so a caller cannot tell which check failed. That last point is design intent (not stated in the spec).

## Example
```
POST /auth/oidc/unknown-idp/start
→ 404 {"code": "oidc_provider_not_found", ...}
```
(The provider id is illustrative.)

## Known gaps
- The spec does not say what happens when the provider becomes unusable during the [callback](oidc-callback.md). The callback always answers with a [`302` ↗](../sw-external-terms.md#http-302-found), so this `404` cannot be its answer there.

## Used by
<!-- used-by:start -->
- [oidc-callback](oidc-callback.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
<!-- used-by:end -->
