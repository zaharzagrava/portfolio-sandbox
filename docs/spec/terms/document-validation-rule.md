---
id: document-validation-rule
title: Document validation rule
kind: term
status: draft
aliases: [rule, rules]
defined_for: S04-kyc-onboarding
rules_hash: 5887f43448cb
---
# Document validation rule
## Definition
A document validation rule is a [hard check](hard-checks.md) applied to the values the AI model extracts from a [KYC ↗](../sw-external-terms.md#kyc) document. Rules decide acceptance, not the model's confidence, so a document with any issue is never [auto-approved](auto-approval.md). Some issues are marked [escalating](escalating-issue.md) and send the document once to the [strong model](strong-model.md); the rest go to human review. When a [moderator](moderator.md) approves a [task](moderation-task.md), the same hard checks run again.

## Example
The [cheap model](cheap-model.md) reads a `BANK_STATEMENT` and its answer passes every rule. The document becomes `APPROVED` after one model call. If a moderator later approves a task with an [IBAN ↗](../sw-external-terms.md#iban) that fails the check, the answer is `[422 iban_invalid](iban-invalid.md)`.

## Known gaps
- The spec does not list the full set of rules. It names only the IBAN check, the VAT check, the [key-field check](key-field.md) and the [holder name comparison](holder-name-check.md).
- The spec does not say which issues are escalating, apart from a low-confidence IBAN.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-07
- [document-status](document-status.md)
<!-- used-by:end -->
