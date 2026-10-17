---
id: hard-checks
title: Hard checks
kind: term
status: draft
aliases: [hard check]
defined_for: S04-kyc-onboarding
rules_hash: 6d282d346e71
---
# Hard checks
## Definition
Hard checks are fixed rules that decide whether [extracted document data](extraction-evidence.md) is acceptable. They decide acceptance, not the model's confidence. They run during model extraction and again when a [moderator](moderator.md) approves a review task, so a human cannot approve data that the rules would refuse. They include a valid [IBAN ↗](../sw-external-terms.md#iban), a valid [VAT number](vat-registered.md), and the presence of every [key field](key-field.md). During extraction, a failed check becomes an issue that sends the document to review. At approval, a failed check refuses the approval with a 422 code.

## Example
The cheap model reads a `BANK_STATEMENT` and returns an IBAN that fails the IBAN check. The document is not auto-approved and goes to [`NEEDS_REVIEW`](document-status.md). A moderator then approves it without fixing the IBAN. The answer is `[422 iban_invalid](iban-invalid.md)`. If the moderator approves with a corrected IBAN that passes the check, the approval succeeds.

## Known gaps
- The spec does not list the full set of hard checks per document kind beyond the IBAN check, the VAT check and the key-field check.
- The spec does not say whether the holder-name match against the business name (seen in S04.B-10) is a hard check or a separate issue type.
- Not confirmed in the code: where the shared check logic lives, or whether extraction and approval really call the same function.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-24
- [auto-approval](auto-approval.md)
- [cheap-model](cheap-model.md)
- [document-issue](document-issue.md)
- [document-review](document-review.md)
- [document-validation-rule](document-validation-rule.md)
- [extraction-worker](extraction-worker.md)
- [iban-invalid](iban-invalid.md)
- [model-confidence](model-confidence.md)
- [rejected-operation](rejected-operation.md)
- [review-task](review-task.md)
- [vat-invalid](vat-invalid.md)
<!-- used-by:end -->
