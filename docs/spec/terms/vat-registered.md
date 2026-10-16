---
id: vat-registered
title: VAT registered
kind: term
status: draft
aliases: [vat registration]
defined_for: S04-kyc-onboarding
rules_hash: 2ac9a27290ea
---
# VAT registered
## Definition
VAT registered is the questionnaire answer `vatRegistered` that says whether the shop is registered for VAT. It drives two things. At submit, `true` requires a [`vatNumber`](vat-number.md) valid for the business country, and `false` forbids one; a violation returns [`validation_failed`](validation-failed-error.md). It also decides whether `VAT_CERTIFICATE` is a required onboarding document type.

## Example
`vatRegistered: true` with no `vatNumber` gets `400 validation_failed` at submit. `vatRegistered: false` gives required documents `BUSINESS_REGISTRATION` and `BANK_STATEMENT` only.

## Known gaps
- The spec does not say which of the four questionnaire steps holds `vatRegistered` and `vatNumber`.
- The spec does not say how "the VAT number fits the business country" is checked (format only, or an external registry).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
