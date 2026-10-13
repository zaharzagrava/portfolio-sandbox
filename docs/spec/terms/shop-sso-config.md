---
id: shop-sso-config
title: ShopSsoConfig table
kind: term
status: draft
aliases: [shopssoconfig]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# ShopSsoConfig table
## Definition
`ShopSsoConfig` is a table owned by the [tenancy capability](capability.md). It stores a shop's per-shop [SSO ↗](../sw-external-terms.md#sso) setting, which is the [identity provider ↗](../sw-external-terms.md#identity-provider) the shop uses for company sign-in. An owner writes this setting with `PUT /shops/:shopId/sso`. The anonymous lookup [`GET /shops/by-slug/:slug/sso`](shop-sso-lookup.md) reports whether a shop has company sign-in, which depends on this setting.

## Example
An owner of the shop with slug `acme-tools` (illustrative) sets up company sign-in. Later, an anonymous sign-in page checks the slug:
```
PUT /shops/{shopId}/sso              (caller is an OWNER)  → setting stored in ShopSsoConfig
GET /shops/by-slug/acme-tools/sso    (anonymous)           → 200
```

## Known gaps
- The spec does not say which columns the table has, or how any identity-provider secrets in it are stored.
- The spec does not say how the anonymous slug lookup reads this table, given that [tenancy tables](tenancy-tables.md) must be unreadable without a tenant set (S03.R-19). Not confirmed in the code: whether `ShopSsoConfig` counts as a tenancy table.
- The spec does not say whether a shop can have more than one identity provider, or how an owner turns company sign-in off.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [sso-controller](sso-controller.md)
- [tenancy-tables](tenancy-tables.md)
<!-- used-by:end -->
