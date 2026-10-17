---
id: content-type-mismatch
title: content_type_mismatch
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: 62b90efd1bed
---
# content_type_mismatch
## Definition
`content_type_mismatch` is the issue recorded when a document's [real file type](real-file-type.md), read from its bytes, differs from the type the seller declared. The document goes straight to [human review](document-review.md) and no [model call](model-call.md) is made. A missing [storage object](missing-object.md) also skips the model and goes to review.

## Example
A seller declares a document as PDF, but the uploaded bytes are a PNG. When the [extraction worker](extraction-worker.md) processes it, no model is called. The [review task](review-task.md) shows `content_type_mismatch`.

## Known gaps
- The spec does not say which issue code a missing storage object produces.
- The spec does not say whether the seller sees this code or only a moderator's rejection reason.

## Used by
<!-- used-by:start -->
- [upload-mismatch](upload-mismatch.md)
<!-- used-by:end -->
