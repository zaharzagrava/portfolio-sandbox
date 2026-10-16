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
_nobody yet_
<!-- used-by:end -->
