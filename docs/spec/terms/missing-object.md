---
id: missing-object
title: Missing object
kind: term
status: draft
aliases: [object]
defined_for: S04-kyc-onboarding
rules_hash: 183cebb3c795
---
# Missing object
## Definition
A missing object is a document whose file is not found in storage when the [extraction worker](extraction-worker.md) processes it. This happens, for example, if the upload never reached storage or the file was deleted. The worker does not call a model for it. It sends the document to [document review](document-review.md) so a [moderator](moderator.md) decides.

## Example
A `BUSINESS_REGISTRATION` document is [`QUEUED`](document-status.md), but the worker finds no stored file for it. The document goes to [`NEEDS_REVIEW`](document-status.md) with an open [review task](review-task.md), and no model call is made (S04.R-18).

## Known gaps
- The spec does not say which review reason code a missing object gets.
- The spec does not say whether the worker retries the storage read before sending the document to review.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-18
- [S31](../capabilities/S31-assets-digital-delivery.md): R-24
- [content-type-mismatch](content-type-mismatch.md)
- [document-review](document-review.md)
- [extraction-worker](extraction-worker.md)
- [moderator](moderator.md)
- [review-task](review-task.md)
<!-- used-by:end -->
