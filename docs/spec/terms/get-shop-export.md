---
id: get-shop-export
title: GET /shops/:shopId/export
kind: term
status: draft
aliases: [/shops/:shopid/export, shop export]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# GET /shops/:shopId/export
## Definition
`GET /shops/:shopId/export` lets an owner download everything the [tenancy capability](tenant.md) holds about their shop. The answer includes the shop, its members with their addresses, its invites and its [SSO configuration](shop-sso-config.md) without secrets. It is sent with [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). It still works when the shop is [suspended](shop-status.md) or closing, because [`shop.export`](permission.md) is one of the permissions a suspended shop keeps. It covers only tenancy data, not data owned by other capabilities.

## Example
An owner of a `SUSPENDED` shop calls `GET /shops/:shopId/export`. The answer contains the shop, members, invites and the SSO configuration, with [`secretSet`](secret-set.md) instead of the client secret. The response header is:
```
Cache-Control: no-store
```

## Known gaps
- The spec does not say the format or schema of the export.
- The spec does not say whether an [`ADMIN`](shop-role.md) can call it. The behavior names only an owner, but S03.R-05 refers to a `shop.export` permission, and the [role permission matrix](role-permission-matrix.md) decides who has it.
- Not confirmed in the code: that [invite tokens](invite-token.md) or their digests are left out of the export. S03.R-14 forbids tokens in any API response, but the export is not checked against that rule specifically.

## Used by
<!-- used-by:start -->
- [invite-token](invite-token.md)
- [role-permission-matrix](role-permission-matrix.md)
- [shop-sso-config](shop-sso-config.md)
- [shop-status](shop-status.md)
- [tenant](tenant.md)
<!-- used-by:end -->
