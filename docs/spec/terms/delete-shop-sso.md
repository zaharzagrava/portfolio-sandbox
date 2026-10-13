---
id: delete-shop-sso
title: DELETE /shops/:shopId/sso
kind: term
status: draft
aliases: [/shops/:shopid/sso]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# DELETE /shops/:shopId/sso
## Definition
`DELETE /shops/:shopId/sso` is the endpoint an owner calls to remove a shop's company sign-in configuration. It deletes the shop's row in the [ShopSsoConfig table](shop-sso-config.md), including the [sealed client secret](client-secret.md). It does not just switch the row off. After that, the shop has no [identity provider ↗](../sw-external-terms.md#identity-provider), so a login through it [resolves as unknown](resolve-as-unknown.md). `GET /shops/:shopId/sso` then answers [`sso_not_configured`](sso-not-configured.md). The usual answer order still applies: `401`, then [`404 shop_not_found`](shop-not-found.md), then the permission check, then the [shop status gate](shop-status-gate.md).

## Example
An owner of the shop removes the provider, then reads the configuration again:
```
DELETE /shops/:shopId/sso   → success (the row is deleted)
GET    /shops/:shopId/sso   → 404 sso_not_configured
```

## Known gaps
- The spec does not say which success status the endpoint returns (for example `204`), or what it answers when the shop has no configuration to remove.
- The spec does not say which error a non-owner member gets: [`403 permission_denied`](permission-denied.md) or [`403 insufficient_role`](insufficient-role.md).
- The spec does not say what happens to members who joined through the provider (`source: sso`) or to their sessions when the configuration is removed. Ending those sessions is only stated for the [shop purge](shop-purge.md).

## Used by
<!-- used-by:start -->
- [client-secret](client-secret.md)
- [resolve-as-unknown](resolve-as-unknown.md)
- [shop-purge](shop-purge.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
