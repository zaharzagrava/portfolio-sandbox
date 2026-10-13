---
id: reserved-slug
title: Reserved slug (slug_reserved)
kind: term
status: draft
aliases: [reserved handle, slug_reserved]
defined_for: S03-shops-rbac
rules_hash: 0f33dbdf30cd
---
# Reserved slug (slug_reserved)
## Definition
A reserved slug is a [handle](shop-slug.md) that the system keeps for itself, so no [shop](shop-tenant.md) can take it. A create request that uses a reserved slug answers `422 slug_reserved`, even if no shop holds that slug. [`checkSlug`](check-slug.md) in the [slug policy](slug-policy.md) runs this check. Design intent (not stated in the spec): the reservation stops shops from taking handles that could clash with platform routes or names, or mislead buyers.

## Example
[`POST /shops`](post-shops.md) with `{"slug": "admin"}` answers `422 slug_reserved` (`admin` as a reserved handle is illustrative).

## Known gaps
- The spec does not say which handles are reserved, or where that list is kept and maintained.
- The spec does not say whether the reserved check runs before or after the format check when both fail.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-13
- [check-slug](check-slug.md)
- [shop-slug](shop-slug.md)
- [shop-tenant](shop-tenant.md)
- [slug-policy](slug-policy.md)
- [slug-taken](slug-taken.md)
<!-- used-by:end -->
