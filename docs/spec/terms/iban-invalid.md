---
id: iban-invalid
title: iban_invalid (422)
kind: term
status: draft
aliases: [iban_invalid]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# iban_invalid (422)
## Definition
`iban_invalid` is the 422 error code a [moderator](moderator.md) gets when they try to approve a [review task](review-task.md) whose [IBAN ↗](../sw-external-terms.md#iban) fails the IBAN [hard check](hard-checks.md). The approval is refused and the task stays open. The moderator can approve again with a corrected IBAN. The task then stores the masked extracted value and the masked corrected value, and the [sealed copy](sealed-copy.md) holds the correction.

## Example
A review task for a `BANK_STATEMENT` holds an extracted IBAN that fails the check. The moderator approves it as is and gets `422 iban_invalid`. The moderator then approves with a corrected IBAN (illustrative: `DE89 3704 0044 0532 0130 00`). The approval passes, and the document becomes `APPROVED`.

## Known gaps
- The spec does not say what the IBAN check verifies (format, country length, checksum, or more).
- The spec does not say whether the IBAN must also match the business country from the questionnaire.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
