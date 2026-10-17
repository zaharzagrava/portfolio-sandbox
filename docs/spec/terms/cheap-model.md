---
id: cheap-model
title: Cheap model
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: 3d71d933d634
---
# Cheap model
## Definition
The cheap model is the first AI model the [extraction worker](extraction-worker.md) calls to read a document. The [hard rules](hard-checks.md), not the model's confidence, decide whether its answer is accepted. If the answer passes every rule, the document is approved with no further call. If an issue is marked [escalating](escalating-issue.md), the worker makes a follow-up call to the [strong model](strong-model.md). The usual reason for this two-tier setup is to keep most documents on the cheaper path. That is design intent (not stated in the spec).

## Example
- A [`BANK_STATEMENT`](onboarding-document-type.md) whose cheap-model answer passes every rule: one call, document `APPROVED`.
- The cheap model returns a low-confidence IBAN, which is an escalating issue: the strong model is called.
- The model reports a holder name that differs from the business name: one call, document [`NEEDS_REVIEW`](document-status.md).

## Known gaps
- The spec does not name the model or the provider behind "cheap model".
- The spec does not list which issues are escalating; only the low-confidence IBAN is shown.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-15, B-07
- [document-status](document-status.md)
- [document-validation-rule](document-validation-rule.md)
- [escalating-issue](escalating-issue.md)
- [extraction-attempt](extraction-attempt.md)
- [extraction-worker](extraction-worker.md)
- [hard-checks](hard-checks.md)
- [invalid-output](invalid-output.md)
- [model-confidence](model-confidence.md)
- [strong-model](strong-model.md)
<!-- used-by:end -->
