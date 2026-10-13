---
id: shop-slug
title: Shop slug
kind: term
status: draft
aliases: [slug, slugs]
defined_for: S03-shops-rbac
rules_hash: 01d5112da492
---
# Shop slug
## Definition
A shop slug is the short, URL-friendly handle a shop gets when it is created with [`POST /shops`](post-shops.md). It may contain only lower-case letters, digits and hyphens, and it cannot start or end with a hyphen. The slug rule limits its length, and each slug can belong to only one shop. Anonymous callers use it to look up a company's sign-in at [`GET /shops/by-slug/:slug/sso`](shop-sso-lookup.md), and the BFF's read of many shops at once returns it.

## Example
A seller creates a shop with the slug `acme-tools` (illustrative), and `POST /shops` answers `201`.
Later, `PATCH /shops/:shopId` with `{"slug": "acme"}` answers [`400 validation_failed`](validation-failed-error.md), because the slug cannot be changed through that endpoint.

## Known gaps
- The spec does not say whether input is lower-cased before the check or rejected when it has upper-case letters.
- The spec does not say whether a slug becomes free again after its shop is [`DELETED`](shop-status.md).
- The spec does not describe any way to change a slug after the shop is created.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-13, B-15
- [batch-shops-lookup](batch-shops-lookup.md)
- [check-slug](check-slug.md)
- [reserved-slug](reserved-slug.md)
- [slug-policy](slug-policy.md)
<!-- used-by:end -->
