---
id: strong-model
title: Strong model
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: e9b025b5633c
---
# Strong model
## Definition
The strong model is the second AI model the extraction worker may call for a document. It runs only when the cheap model's result has an issue marked escalating. It is the last model call a document can get. Its answer goes through the same hard rules and strict-JSON check. If an escalating issue remains, the document goes to `NEEDS_REVIEW` with an open review task.

## Example
- The cheap model returns a low-confidence IBAN. The strong model is called, its answer passes the rules, and the document is `APPROVED`.
- Both models produce an escalating issue. The document is `NEEDS_REVIEW` with one open review task.

## Known gaps
- The spec does not name the model or the provider behind "strong model".
- The spec does not say whether a strong-model answer that is `invalid_output` sends the document straight to review.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-15, B-08
- [cheap-model](cheap-model.md)
- [document-issue](document-issue.md)
- [document-review](document-review.md)
- [document-validation-rule](document-validation-rule.md)
- [escalating-issue](escalating-issue.md)
- [extraction-attempt](extraction-attempt.md)
- [extraction-worker](extraction-worker.md)
- [model-call](model-call.md)
- [model-confidence](model-confidence.md)
<!-- used-by:end -->
