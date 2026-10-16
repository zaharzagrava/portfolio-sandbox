---
id: vat-invalid
title: vat_invalid (422)
kind: term
status: draft
aliases: [vat_invalid]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# vat_invalid (422)
## Definition
`vat_invalid` is the 422 error code that refuses a moderator's approval when the document's VAT number fails the [VAT hard check](hard-checks.md). It applies to the same review flow as [`iban_invalid`](iban-invalid.md), and [the task stays open](moderation-task.md). It is different from the [submit-time check](onboarding-submit.md), which answers [`400 validation_failed`](validation-failed-error.md) when the questionnaire's VAT number does not fit the business country.

## Example
A shop answered [`vatRegistered: true`](vat-registered.md) and uploaded a [`VAT_CERTIFICATE`](onboarding-document-type.md). The document went to review, and the extracted VAT number fails the check. The moderator approves it and gets `422 vat_invalid`. The document stays in [`NEEDS_REVIEW`](document-status.md).

## Known gaps
- The spec does not say what the VAT check verifies, for example format, country prefix, or a match with the `vatNumber` given at submit.
- The spec does not say whether a moderator can supply a corrected VAT number the way they can for an IBAN.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
