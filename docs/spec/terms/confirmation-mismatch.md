---
id: confirmation-mismatch
title: confirmation_mismatch (422)
kind: term
status: draft
aliases: [confirmation_mismatch]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# confirmation_mismatch (422)
## Definition
`confirmation_mismatch` is the [`422` ↗](../sw-external-terms.md#http-422-unprocessable-content) error returned when the confirmation in an [offboarding request](shop-offboarding.md) is not the shop's [slug](shop-slug.md). Nothing changes, and the shop stays as it was. Design intent (not stated in the spec): typing the slug stops an [owner](shop-role.md) from closing the wrong shop or closing one by accident.

## Example
The shop slug is `acme-tools` (illustrative). The owner sends [`POST /shops/:shopId/offboarding`](delete-shop-offboarding.md) with the confirmation `acme-tool`, so the answer is `422 confirmation_mismatch`.

## Known gaps
- The spec does not say what the confirmation field in the request is called.
- The spec does not say clearly whether cancelling offboarding also needs the slug. The rule mentions it for both start and cancel, but the [entry point](entry-point.md) only mentions it for start.

## Used by
<!-- used-by:start -->
- [entry-point](entry-point.md)
- [shop-offboarding](shop-offboarding.md)
- [shop-role](shop-role.md)
- [shop-slug](shop-slug.md)
<!-- used-by:end -->
