---
id: sso-controller
title: SsoController
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# SsoController
## Definition
`SsoController` is the HTTP controller for [per-shop SSO](shop-sso-config.md) in the [tenancy capability](capability.md). It lives in `packages/backend/libs/domains/tenancy/api/sso.controller.ts`. The spec cites it for `PUT /shops/:shopId/sso`, where an owner configures the shop's [identity provider ↗](../sw-external-terms.md#identity-provider). Like other non-public shop routes, it answers `[401 invalid_token](invalid-token-error.md)` when there are no credentials. It takes the shop from the path, never from the request body.

## Example
```
PUT /shops/{shopId}/sso   (no credentials)                        → 401 invalid_token
PUT /shops/{shopId}/sso   ([X-Shop-Id header](x-shop-id-header.md) names another shop)   → [400 shop_mismatch](shop-mismatch.md)
PUT /shops/{shopId}/sso   (caller is not a member)                → [404 shop_not_found](shop-not-found.md)
```

## Known gaps
- Not confirmed in the code: whether `SsoController` also handles `GET /shops/by-slug/:slug/sso`. The spec cites code only for the `PUT` route.
- The spec does not say what the `PUT` request body contains or what status a success returns. It also does not name the permission the route checks; it says only "an owner".
- The spec does not say which [rate limit policy](rate-limit-policy.md) applies to the `PUT` route.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [rate-limit-policy](rate-limit-policy.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
