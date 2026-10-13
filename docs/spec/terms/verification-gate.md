---
id: verification-gate
title: Verification gate
kind: term
status: draft
aliases: [gate]
defined_for: S32-product-search
rules_hash: a24d73b4ef1f
---
# Verification gate
## Definition
The verification gate is a check a [reindex run](reindex-run-status.md) passes before the new index can replace the [live one](live-index-alias.md). If the new index holds fewer documents than the record of earlier runs requires, the gate fails the run with [`verification_failed`](verification-failed.md). When the gate fails, the live name keeps pointing at the current index, so [searchers](distinct-searchers.md) are not affected. The purpose is design intent (not stated in the spec): it stops a broken or partial build from going live and hiding products.

## Example
An admin starts `POST /admin/search/reindex`. The new index finishes building with far fewer documents than the history calls for. The run ends `FAILED` with `verification_failed`, and `GET /admin/search/index` still reports the old index as live. (Illustrative scenario; the spec gives no counts.)

## Known gaps
- The spec does not say the exact threshold, meaning how many fewer documents are allowed.
- The spec does not say at which status the gate runs (`BUILDING` or `CATCHING_UP`), so it is unclear which `→ FAILED` transition it uses.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-20
- [distinct-searchers](distinct-searchers.md)
- [live-index-alias](live-index-alias.md)
- [reindex-history](reindex-history.md)
- [reindex-run-status](reindex-run-status.md)
<!-- used-by:end -->
