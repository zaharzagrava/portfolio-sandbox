---
id: real-file-type
title: Real file type
kind: term
status: draft
aliases: [declared type]
defined_for: S04-kyc-onboarding
rules_hash: 6d434b2c0d26
---
# Real file type
## Definition
The real file type is the format of an uploaded document as detected from its bytes, not from what the seller declared. The [extraction worker](extraction-worker.md) checks it before any [model call](model-call.md). If it differs from the declared type, the document goes to [document review](document-review.md) with the reason [`content_type_mismatch`](content-type-mismatch.md) and no model is called. Only the allowed types and their size caps are accepted at upload (see S04.R-09).

## Example
A seller requests a [`BANK_STATEMENT`](onboarding-document-type.md) upload declared as PDF but uploads a PNG. When the worker processes it, the bytes say PNG. No model call happens, and the [review task](review-task.md) carries `content_type_mismatch` (S04.B-11).

## Known gaps
- The spec does not say how the type is detected from the bytes (which signatures, which library).
- The spec does not say what happens when the real type is not one of the allowed types at all, as opposed to a different allowed type.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
