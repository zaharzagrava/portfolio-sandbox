---
id: extraction-worker
title: Extraction worker
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: c32bacd18424
---
# Extraction worker
## Definition
The extraction worker consumes extraction messages from the `onboarding-documents` queue and decides one document per message. It holds a [lease](concurrency-lease.md) on the document, so concurrent copies do not process it twice, and it never repeats a completed attempt. It reads the real file type from the bytes and calls the cheap model, then the [strong model](strong-model.md) only for an escalating issue. [Hard checks](hard-checks.md) then set the document to `APPROVED` or `NEEDS_REVIEW` with a review task. It holds no database transaction open during a model call or storage call. Provider errors propagate so the queue redelivers.

## Example
- A queued `BANK_STATEMENT` comes in, and the cheap model returns a low-confidence IBAN, which is an escalating issue.
- The worker calls the strong model once.
- If that answer passes every rule, the document becomes `APPROVED`. Otherwise it goes to `NEEDS_REVIEW` with one open review task.
- A document declared PDF whose bytes are a PNG goes straight to review with `content_type_mismatch`, and no model is called.

## Known gaps
- The spec does not say how long the per-document lease lasts, or what happens when a worker dies while holding it.
- The spec does not say whether an auto-approval by the worker can itself be the last required approval that makes the application `VERIFIED`. The rule is stated only for "the last required kind is approved".
- Not confirmed in the code: the handler path `packages/backend/apps/lambdas/src/handlers/document-extractor.ts#handler` is confirmed only for parsing messages and failing malformed batch items. The facts do not show the lease, model calls or storage in that file.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-05
- [admin-bootstrap](admin-bootstrap.md)
- [auto-approval](auto-approval.md)
- [cheap-model](cheap-model.md)
- [concurrency-lease](concurrency-lease.md)
- [content-type-mismatch](content-type-mismatch.md)
- [document-id](document-id.md)
- [extraction-message](extraction-message.md)
- [hard-checks](hard-checks.md)
- [local-queue-configuration](local-queue-configuration.md)
- [missing-object](missing-object.md)
- [model-call](model-call.md)
- [onboarding-documents-queue](onboarding-documents-queue.md)
- [raw-document-file](raw-document-file.md)
- [real-file-type](real-file-type.md)
- [strong-model](strong-model.md)
<!-- used-by:end -->
