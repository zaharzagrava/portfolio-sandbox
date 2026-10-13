---
id: oidc-provider-unavailable
title: oidc_provider_unavailable (503)
kind: term
status: draft
aliases: [oidc_provider_unavailable]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# oidc_provider_unavailable (503)
## Definition
`oidc_provider_unavailable` is the `503` answer when a provider exists but cannot be reached or resolved right now. As an HTTP status, the spec names it for an [OIDC provider resolver](oidc-provider-resolver.md) that throws an error. The same code also appears as a [login error](oidc-login-error.md) on the [callback redirect](oidc-callback.md), for example when the provider's [token endpoint ↗](../sw-external-terms.md#oauth-token-endpoint) does not respond in time. There it is sent as `error=oidc_provider_unavailable`, not as a `503`.

## Example
```
POST /auth/oidc/<resolved-provider-id>/start   (the resolver throws)
→ 503 {"code": "oidc_provider_unavailable", ...}
```
The callback form, after a token endpoint stays silent for 3 s: a `302` redirect carrying `error=oidc_provider_unavailable`, sent within 10 s, after one token request and no retry.

## Known gaps
- The spec does not say whether the `503` answer includes [`Retry-After` ↗](../sw-external-terms.md#retry-after), or whether clients should retry.
- The spec does not say whether a resolver timeout, as opposed to a thrown error, also maps to this code.

## Used by
<!-- used-by:start -->
- [oidc-callback](oidc-callback.md)
- [oidc-login-error](oidc-login-error.md)
- [oidc-provider-resolver](oidc-provider-resolver.md)
<!-- used-by:end -->
