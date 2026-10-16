---
id: escalating-issue
title: Escalating issue
kind: term
status: draft
aliases: [escalating]
defined_for: S04-kyc-onboarding
rules_hash: d0a0ec338e7a
---
# Escalating issue
## Definition
An escalating issue is a [document issue](document-issue) that is marked as worth a second opinion from the [strong model](strong-model.md). Only an escalating issue can cause the [second model call](model-call.md) on a document (S04.R-15). If the strong model's answer passes every rule, the document can still be approved. If the strong model also produces an escalating issue, the document goes to [`NEEDS_REVIEW`](document-status.md) with one open [review task](review-task.md).

## Example
The cheap model reads a `BANK_STATEMENT` and returns the IBAN with low confidence. That issue escalates, so the strong model is called once. Its answer passes every rule, and the document becomes `APPROVED` (S04.B-08).

## Known gaps
- The spec does not say which issue kinds are marked escalating. It names only the low-confidence IBAN case.
- The spec does not say what decides that a confidence is "low".
- Not confirmed in the code: where the escalating mark is set, or whether it is a field on the issue or a fixed list of issue kinds.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
