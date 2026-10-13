---
id: my-role
title: myRole
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# myRole
## Definition
`myRole` is a field in the answer to [`GET /shops/:shopId`](get-shop-by-id.md). It holds the caller's own [shop role](shop-role.md) in that shop. It comes back with `myPermissions`, the [permissions](permission.md) that role grants. A client can use it to decide what to show, such as hiding team-management buttons from a viewer. The server still checks permissions on every request, whatever the client shows.

## Example
A member calls `GET /shops/:shopId` and gets back the shop plus their own access (values are illustrative):
```json
{ "myRole": "STAFF", "myPermissions": ["shop.read", "members.read"] }
```

## Known gaps
- The spec does not say whether `myRole` is read from the [authorization cache](authorization-cache.md) or the database. Just after a role change, it may be briefly out of date.
- The spec does not say whether [`GET /shops/mine`](get-shops-mine.md) uses the same field name for "their role".

## Used by
<!-- used-by:start -->
- [authorization-cache](authorization-cache.md)
- [permission](permission.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
