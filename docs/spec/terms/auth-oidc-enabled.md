---
id: auth-oidc-enabled
title: AUTH_OIDC_ENABLED
kind: term
status: draft
aliases: []
defined_for: W01-auth-account
rules_hash: e3b0c44298fc
---
# AUTH_OIDC_ENABLED
## Definition
`AUTH_OIDC_ENABLED` is a server-side configuration flag that the web app reads. It is passed as a boolean to the **Continue with Google** button on `[/login](login-page.md)`. The button shows only when this flag is true and the [provider list](oidc-provider-registry.md) contains `google`. If either check fails, the button stays hidden. Requiring both checks is likely there so operators can turn Google sign-in off in the web app without changing provider configuration. That is design intent (not stated in the spec).

## Example
```
AUTH_OIDC_ENABLED=true   + provider list contains google → /login shows "Continue with Google"
AUTH_OIDC_ENABLED=false  + provider list contains google → button hidden
AUTH_OIDC_ENABLED=true   + provider list has no google   → button hidden
```
(The written form of the values is illustrative.)

## Known gaps
- The spec does not say which text values count as true, or what the default is when the variable is unset.
- The spec does not say whether the flag only hides the button, or whether the backend also refuses Google sign-in when it is false. Do not rely on it as a [security control ↗](../sw-external-terms.md#access-control).
- The spec does not say where `/login` gets the provider list from. It may be [GET /auth/oidc/providers](get-auth-oidc-providers.md), but that is not confirmed.

## Used by
<!-- used-by:start -->
- [get-auth-oidc-providers](get-auth-oidc-providers.md)
- [oidc-provider-registry](oidc-provider-registry.md)
<!-- used-by:end -->
