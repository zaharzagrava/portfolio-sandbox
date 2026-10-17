---
id: onboarding-documents-queue
title: onboarding-documents queue
kind: term
status: draft
aliases: [onboarding-documents]
defined_for: S04-kyc-onboarding
rules_hash: 6f8d8dfadcb3
---
# onboarding-documents queue
## Definition
The `onboarding-documents` queue is the queue owned by the [KYC onboarding capability ↗](../sw-external-terms.md#kyc). It carries one message kind, the extraction message `onboarding.extract_document`, which names one document to process. Messages reach it through [the outbox](inbox-table.md) when a seller confirms an upload. They are not published directly inside the confirm transaction. The [extraction worker](extraction-worker.md) consumes it. When the worker lets a provider error propagate, the queue redelivers the message.

## Example
A seller confirms a `BANK_STATEMENT` upload. The document moves to `QUEUED`, and this message lands on `onboarding-documents`:
```json
{ "type": "onboarding.extract_document", "documentId": "doc_123" }
```
(`doc_123` is illustrative.)

## Known gaps
- The spec does not say how many redeliveries the queue allows, or whether there is a dead-letter destination after the last one.
- The spec does not say the batch size the consumer receives, or the queue's visibility or retry delay.
- The spec does not say which component moves the outbox row onto the queue (for example the outbox relay).

## Used by
<!-- used-by:start -->
- [document-id](document-id.md)
- [document-upload](document-upload.md)
- [extraction-message](extraction-message.md)
- [extraction-worker](extraction-worker.md)
- [failed-batch-item](failed-batch-item.md)
- [inbox-table](inbox-table.md)
<!-- used-by:end -->
