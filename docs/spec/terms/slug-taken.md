---
id: slug-taken
title: slug_taken (409)
kind: term
status: draft
aliases: [slug_taken]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# slug_taken (409)
## Definition
`[slug](shop-slug.md)_taken` is the [conflict error](conflict-error.md) returned when someone tries to create a shop with a slug that another shop already uses. It answers HTTP `409`. A slug that is valid and [not reserved](reserved-slug.md) can still fail this check. The caller has to choose a different slug.

## Example
Shop `acme-tools` (illustrative) already exists. A second user sends [`POST /shops`](post-shops.md) with `{"slug": "acme-tools"}` and gets `409 slug_taken`.

## Known gaps
- The spec does not say how two simultaneous creates with the same free slug are resolved. One of them presumably gets `slug_taken`, but this is not stated.
- The spec does not say whether slugs of [`DELETING`](shop-status.md) or `DELETED` shops still count as used.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [reserved-slug](reserved-slug.md)
<!-- used-by:end -->
