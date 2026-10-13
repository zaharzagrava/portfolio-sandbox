---
id: sso-not-configured
title: sso_not_configured (404)
kind: term
status: draft
aliases: [sso_not_configured]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# sso_not_configured (404)
## Definition
`sso_not_configured` is the error code that [`GET /shops/:shopId/sso`](get-shop-sso.md) returns with `404` when the shop has no [identity provider ↗](../sw-external-terms.md#identity-provider) configured. It is not the same as [`shop_not_found`](shop-not-found.md). The caller already passed the shop and [permission checks](permission.md), and the only thing missing is the SSO configuration. After an owner removes the configuration with [`DELETE /shops/:shopId/sso`](delete-shop-sso.md), the row is deleted, so the shop is back in this state.

## Example
An owner of a new shop calls `GET /shops/:shopId/sso` before any `PUT /shops/:shopId/sso`, and the answer is:
```
404 sso_not_configured
```

## Known gaps
- The spec does not say whether `DELETE /shops/:shopId/sso` on an unconfigured shop also answers `sso_not_configured`.
- The spec does not say what the anonymous [`GET /shops/by-slug/:slug/sso`](shop-sso-lookup.md) answers for a shop without SSO.

## Used by
<!-- used-by:start -->
- [permission](permission.md)
<!-- used-by:end -->
