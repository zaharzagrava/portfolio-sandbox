---
id: get-shops-mine
title: GET /shops/mine
kind: term
status: draft
aliases: [shops/mine]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# GET /shops/mine
## Definition
`GET /shops/mine` lists the shops the signed-in caller belongs to, with the caller's role in each one. It is [cursor-paginated](pagination-cursor.md): `limit` sets the page size and [`nextCursor`](pagination-cursor.md) leads to the next page. It needs credentials, so an anonymous call gets [`invalid_token`](invalid-token-error.md). Unlike the per-shop endpoints, it takes no shop from the path or [`X-Shop-Id`](x-shop-id-header.md).

## Example
```
GET /shops/mine?limit=2
→ 2 shops + "nextCursor": "<opaque>"
GET /shops/mine?limit=2&<cursor param>=<opaque>
→ 1 shop + "nextCursor": null
```
(The name of the cursor parameter is not given in the spec.)

## Known gaps
- The spec does not say whether [`SUSPENDED`](shop-status.md), [`DELETING`](shop-status.md) or [sandbox shops](sandbox-shop.md) appear in the list.
- The spec does not say the response field name for the role, or the default page size.

## Used by
<!-- used-by:start -->
- [pagination-cursor](pagination-cursor.md)
- [sandbox-shop](sandbox-shop.md)
<!-- used-by:end -->
