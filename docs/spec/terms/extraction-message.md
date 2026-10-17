---
id: extraction-message
title: Extraction message
kind: term
status: draft
aliases: [extraction]
defined_for: S04-kyc-onboarding
rules_hash: 47fe5fb492c4
---
# Extraction message
## Definition
The extraction message is the queue message `onboarding.extract_document` on the [`onboarding-documents` queue](onboarding-documents-queue.md). It asks the [extraction worker](extraction-worker.md) to process one document. Confirming an upload appends it to the [outbox](outbox-append.md) in the same transaction that sets the document to [`QUEUED`](document-status.md). As a result, a queued document always has its message, and a [rolled-back ↗](../sw-external-terms.md#database-transaction) confirm leaves none.

## Example
```json
{ "type": "onboarding.extract_document", "documentId": "doc_123" }
```
The `doc_123` value is illustrative. The handler is `packages/backend/apps/lambdas/src/handlers/document-extractor.ts#handler`.

A message without a valid `documentId` becomes a [failed batch item](failed-batch-item.md). No model call is made, and the other items in the batch still run.

## Known gaps
- The spec does not say whether the message carries anything beyond `documentId`.
- The spec does not say how many redeliveries are allowed after provider errors, or where a message goes after the last one.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-13
- [document-upload](document-upload.md)
- [extraction-worker](extraction-worker.md)
- [failed-batch-item](failed-batch-item.md)
- [late-result](late-result.md)
- [model-call](model-call.md)
- [model-confidence](model-confidence.md)
- [onboarding-documents-queue](onboarding-documents-queue.md)
- [outbox-append](outbox-append.md)
- [review-task](review-task.md)
- [strict-json](strict-json.md)
- [upload-grant](upload-grant.md)
<!-- used-by:end -->
