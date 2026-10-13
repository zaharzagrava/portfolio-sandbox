---
id: shop-sso-lookup
title: GET /shops/by-slug/:slug/sso
kind: term
status: draft
aliases: [shops/by-slug]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# GET /shops/by-slug/:slug/sso
## Definition
`GET /shops/by-[slug](shop-slug.md)/:slug/sso` is a public endpoint that anyone can call without signing in. It tells the caller whether the shop with a given slug has [company sign-in ↗](../sw-external-terms.md#sso). An owner sets that up with `PUT /shops/:shopId/sso`, and the setting is stored in the [`ShopSsoConfig`](shop-sso-config.md) table. The endpoint answers with either a `200` or [an identical 404](identical-not-found.md). The spec says not-found answers are uniform so callers cannot probe which shops exist. Calls are limited per IP address by the [`tenancy.sso-lookup.ip`](rate-limit-policy.md) rate limit policy. The reason it exists is design intent (not stated in the spec): it lets a sign-in page decide whether to offer company sign-in before it knows who the user is.

## Example
An anonymous visitor's sign-in page checks the slug `acme-tools` (illustrative):
```
GET /shops/by-slug/acme-tools/sso      → 200
GET /shops/by-slug/no-such-shop/sso    → 404 (same answer as any other miss)
```

## Known gaps
- The spec does not say what the `200` body contains, for example the identity provider details or only a yes/no flag.
- The spec does not say which cases give the 404 or which error code it carries. Those cases could include an unknown slug, a shop without SSO, or a suspended or deleted shop.
- The spec does not give the limit values of `tenancy.sso-lookup.ip`. Not confirmed in the code: the handler for this route is cited nowhere, and the code is cited only for [`SsoController`](sso-controller.md) on the `PUT` route.

## Used by
<!-- used-by:start -->
- [identical-not-found](identical-not-found.md)
<!-- used-by:end -->
