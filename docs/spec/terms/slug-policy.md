---
id: slug-policy
title: Slug policy
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# Slug policy
## Definition
The slug policy is the set of rules for what a [shop slug](shop-slug.md) may be. It lives in the [tenancy domain](tenancy-tables.md) as `slug-policy.ts`, and [`checkSlug`](check-slug.md) applies it. It covers the allowed format, answers `422` to handles that are held back from shop use, and answers [`409 slug_taken`](slug-taken.md) to slugs already in use. The policy applies when a shop is created. A later `PATCH /shops/:shopId` that carries `slug` answers `400 validation_failed`.

## Example
The rule S03.R-13 says a slug must be 3 to 40 characters of `[a-z0-9-]`, with no leading or trailing hyphen. So `acme-tools` is valid. `Acme_Tools` is refused because of the uppercase letters and the underscore. These two slug values are illustrative.

## Known gaps
- The spec does not say which handles are reserved, or where that list is kept and maintained.
- The spec does not say whether an existing slug can ever be changed, for example by an operator. It only says the member-facing `PATCH` refuses it.
- The spec does not say whether the slug of a deleted shop becomes free to use again.

## Used by
<!-- used-by:start -->
- [check-slug](check-slug.md)
- [post-shops](post-shops.md)
- [reserved-slug](reserved-slug.md)
- [shop-slug](shop-slug.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
- [tenancy-tables](tenancy-tables.md)
<!-- used-by:end -->
