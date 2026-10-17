---
id: document-content-hash
title: Document content hash
kind: term
status: draft
aliases: [content hash]
defined_for: S04-kyc-onboarding
rules_hash: aeb29dca9420
---
# Document content hash
## Definition
The document content hash is the [SHA-256 ↗](../sw-external-terms.md#sha-256) digest of the file the seller wants to upload. The seller declares it in the upload request, written as lowercase hex. Together with the shop, [round](document-round.md) and [kind](document-kind.md), it identifies a document. A repeated request with the same hash therefore returns the existing document instead of creating a new one.

## Example
```json
{ "kind": "BANK_STATEMENT", "contentType": "application/pdf",
  "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }
```
Field names in this body are illustrative.

## [Known gaps](known-gaps.md)
- The spec does not say whether the server recomputes the hash from the uploaded bytes and rejects a mismatch. Only a size check on [confirm](document-upload.md) is described, and that check has no proving scenario.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-10
- [document-deduplicated-flag](document-deduplicated-flag.md)
- [document-kind](document-kind.md)
- [document-round](document-round.md)
- [document-upload](document-upload.md)
- [known-gaps](known-gaps.md)
<!-- used-by:end -->
