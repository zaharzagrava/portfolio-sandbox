---
id: document-review
title: Document review
kind: term
status: draft
aliases: [review]
defined_for: S04-kyc-onboarding
rules_hash: dadffa7bcbbd
---
# Document review
## Definition
Document review is the human step for any document the automatic checks cannot accept. The document moves to [`NEEDS_REVIEW`](document-status.md) and gets one [open review task](review-task.md). A [`MODERATOR`](moderator.md) or [`ADMIN`](platform-admin.md) resolves it by approving, rejecting the document, or rejecting the application. Causes include any [rule issue](document-issue.md), an [escalating issue](escalating-issue.md) that survives the [strong model](strong-model.md), a real file type mismatch, or a missing object.

## Example
Both models report a low-confidence IBAN on a `BANK_STATEMENT`. The document becomes `NEEDS_REVIEW` with one open task (S04.B-09). A moderator approves with a corrected IBAN, and the [hard checks](hard-checks.md) run again (S04.R-24, S04.B-14).

## Known gaps
- The spec does not list every review reason code; only `content_type_mismatch` is named.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-05
- [S04](../capabilities/S04-kyc-onboarding.md): R-18, B-11
- [conflict-of-interest](conflict-of-interest.md)
- [content-type-mismatch](content-type-mismatch.md)
- [document-issue](document-issue.md)
- [escalating-issue](escalating-issue.md)
- [hard-checks](hard-checks.md)
- [late-result](late-result.md)
- [missing-object](missing-object.md)
- [real-file-type](real-file-type.md)
- [required-document-kind](required-document-kind.md)
- [required-documents](required-documents.md)
- [required-onboarding-documents](required-onboarding-documents.md)
- [review-task](review-task.md)
- [strong-model](strong-model.md)
- [upload-mismatch](upload-mismatch.md)
<!-- used-by:end -->
