---
id: check-slug
title: checkSlug
kind: term
status: draft
aliases: [slug policy]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# checkSlug
## Definition
`checkSlug` is the function in the [slug policy](slug-policy.md) that decides whether a proposed [shop slug](shop-slug.md) is acceptable. It enforces the format rule: allowed characters and length, and no leading or trailing hyphen. It also refuses [reserved handles](reserved-slug.md) with `422 slug_reserved`. The rule it implements, S03.R-13, also says a slug already in use answers [`409 slug_taken`](slug-taken.md).

## Example
[`POST /shops`](post-shops.md) with `{"slug": "acme-tools"}` passes the check. `{"slug": "-acme"}` fails because of the leading hyphen, and `{"slug": "ab"}` fails because it is too short. All of these values are illustrative.

## Known gaps
- Not confirmed in the code: whether `checkSlug` itself checks for a used slug (`slug_taken`) or only checks format and reserved handles, with uniqueness enforced by the store.
- The spec does not say which error code and status a badly formatted slug answers with.
- The spec does not say which check runs first when a slug fails more than one, for example a slug that is both reserved and badly formatted.

## Used by
<!-- used-by:start -->
- [reserved-slug](reserved-slug.md)
- [shop-slug](shop-slug.md)
- [slug-policy](slug-policy.md)
<!-- used-by:end -->
