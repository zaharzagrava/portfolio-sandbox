---
id: document-id
title: documentId
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# documentId
## Definition
`documentId` is the identifier of one onboarding document that a seller uploads for a shop. It is the only content of the [`onboarding.extract_document`](extraction-message.md) extraction message on the [`onboarding-documents` queue](onboarding-documents-queue.md). The [extraction worker](extraction-worker.md) uses it to find the document, take the [per-document lease](job-lease.md), and run the extraction. A [deduplicated document request](document-deduplicated-flag.md) returns the same document ID as the original request.

## Example
After the seller confirms an upload, the document moves to [`QUEUED`](document-status.md) and this message is appended to the [outbox](inbox-table.md) (ID value illustrative):
```json
{ "type": "onboarding.extract_document", "documentId": "doc_7f3a91" }
```
A message without `documentId` is a [malformed queue message](malformed-queue-message.md) and becomes a [failed batch item](failed-batch-item.md).

## Known gaps
- The spec does not say the format of a document ID (UUID, prefixed string, or number), so do not validate it by shape.
- The spec does not say whether API responses use the name `documentId`. The seller view lists each document as `{id, kind, status, rejectionReason}`, so the same value appears there as `id`.
- Not confirmed in the code: that `documentId` is the primary key of the `ShopDocument` row, although the extractor handler in `packages/backend/apps/lambdas/src/handlers/document-extractor.ts` reads it from the message.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
