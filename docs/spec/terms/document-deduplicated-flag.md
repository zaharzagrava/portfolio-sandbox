---
id: document-deduplicated-flag
title: deduplicated flag
kind: term
status: draft
aliases: [deduplicated]
defined_for: S04-kyc-onboarding
rules_hash: b260788a5b7b
---
# deduplicated flag
## Definition
`deduplicated` is a member of the answer to a [document upload request](document-upload.md). It is `true` when a document with the same shop, [round](document-round.md), [kind](document-kind.md) and [content hash](document-content-hash.md) already exists. In that case the answer is `200` and carries the existing document's ID, and no new document is created. A seller can therefore safely retry the same upload request.

## Example
```json
{ "id": "doc_123", "status": "AWAITING_UPLOAD", "deduplicated": true }
```
The ID and status are illustrative. A first-time request answers `201` instead.

## Known gaps
- The spec does not say whether a deduplicated answer issues a fresh [upload grant](upload-grant.md) or the original one.
- The spec does not say whether a deduplicated request counts against the per-shop upload request limit.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
