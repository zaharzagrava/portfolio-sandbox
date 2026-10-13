---
id: get-shop-sso
title: GET /shops/:shopId/sso
kind: term
status: draft
aliases: [/shops/:shopid/sso]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# GET /shops/:shopId/sso
## Definition
`GET /shops/:shopId/sso` lets an [`OWNER`](shop-role.md) read the [identity provider configuration](shop-sso-config.md) of their shop. The answer never contains the [client secret ↗](../sw-external-terms.md#oauth-client-secret). The [`secretSet`](secret-set.md) field only shows whether a secret is stored. The endpoint sits with `PUT /shops/:shopId/sso` and `DELETE /shops/:shopId/sso` in [`SsoController`](sso-controller.md). Like other shop endpoints, it follows the shop rules: [`shop_not_found`](shop-not-found.md) for non-members and [the fixed order of error answers](error-catalogue.md).

## Example
An owner of a shop checks its company sign-in setup (illustrative values):
```json
{ "issuer": "https://login.example.com", "clientId": "abc123", "defaultRole": "STAFF", "secretSet": true }
```

## Known gaps
- The spec does not say which status a shop with no SSO configuration gets. It may be [`sso_not_configured`](sso-not-configured.md), but this is not confirmed for this endpoint.
- The spec does not say whether a [`SUSPENDED`](shop-status.md) shop may still read its configuration. The [status gate](shop-status-gate.md) lists only [`shop.read`](permission.md), `members.read` and `shop.export` as allowed.
- The spec does not say which members other than an `OWNER` are refused, or which code they get ([`permission_denied`](permission-denied.md) or [`insufficient_role`](insufficient-role.md)).

## Used by
<!-- used-by:start -->
- [error-catalogue](error-catalogue.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
