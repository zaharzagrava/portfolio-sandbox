---
id: get-auth-oidc-providers
title: GET /auth/oidc/providers
kind: term
status: draft
aliases: [/auth/oidc/providers]
defined_for: S02-mfa-oidc
rules_hash: ddf8efa82615
---
# GET /auth/oidc/providers
## Definition
`GET /auth/oidc/providers` lists the enabled [static providers](static-provider-configuration.md). Each entry holds only an `id` and a `displayName`. The front end can use the list to show one sign-in button per provider and then call [OIDC start](oidc-start.md) with the chosen `id`. That use is design intent (not stated in the spec). [Dynamic providers](dynamic-provider.md) that [S03](../capabilities/S03-shops-rbac.md) supplies through the [`OidcProviderRegistry`](oidc-provider-registry.md) are not part of this list.

## Example
```json
[{ "id": "google", "displayName": "Google" }]
```
The values are illustrative. The spec gives only the `{id, displayName}` shape. The client then calls `POST /auth/oidc/google/start`.

## Known gaps
- The spec does not say whether the list is a bare array or wrapped in an object.
- The spec does not say whether the endpoint needs a signed-in caller, or whether the `auth.oidc.ip` rate-limit policy applies to it.
- The spec does not say whether the order of providers in the list is fixed.

## Used by
<!-- used-by:start -->
- [auth-oidc-enabled](auth-oidc-enabled.md)
- [dynamic-provider](dynamic-provider.md)
- [login-page](login-page.md)
- [oidc-start](oidc-start.md)
- [static-provider-configuration](static-provider-configuration.md)
<!-- used-by:end -->
