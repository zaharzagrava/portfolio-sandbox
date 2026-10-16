---
id: failed-batch-item
title: Failed batch item
kind: term
status: draft
aliases: [batch item]
defined_for: S04-kyc-onboarding
rules_hash: ff79bd0323fd
---
# Failed batch item
## Definition
A failed batch item is one message in a [consumer batch](consumer-batch.md) that the document extractor marks as failed while it handles the rest normally. A [malformed queue message](malformed-queue-message.md) on the [`onboarding-documents` queue](onboarding-documents-queue.md) becomes a failed batch item. Nothing happens for it: no model call is made and no row changes. The other messages in the same batch keep processing. Design intent (not stated in the spec): one bad message should not block or redo the valid documents that arrived with it.

## Example
A batch from `onboarding-documents` holds three messages. Two are valid `onboarding.extract_document {documentId}` messages, and the third has no [`documentId`](document-id.md). The two valid documents are extracted as usual. Only the third is reported as a failed batch item, and no `ShopDocument` or `DocumentExtraction` row is touched for it.

## Known gaps
- The spec does not say what happens to a failed batch item afterwards, for example whether the queue redelivers it or sends it to a [dead-letter topic](dead-letter-topic.md).
- The spec does not say exactly what makes a message "malformed" (missing `documentId`, wrong type, unknown message name).
- Not confirmed in the code: how the handler in `packages/backend/apps/lambdas/src/handlers/document-extractor.ts` reports the failed item to the queue.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
