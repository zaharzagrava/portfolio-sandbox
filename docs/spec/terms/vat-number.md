---
id: vat-number
title: vatNumber
kind: term
status: draft
aliases: [vat number]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# vatNumber
## Definition
`vatNumber` is the [questionnaire](onboarding-questionnaire.md) answer that holds the shop's VAT identification number. It must be consistent with [VAT registered](vat-registered.md) at submit. A shop with `vatRegistered: true` must give one, and a shop with `vatRegistered: false` must not. The number must also fit the business country given in the questionnaire. Any violation makes [onboarding submit](onboarding-submit.md) fail with [`validation_failed`](validation-failed-error.md).

## Example
Submitting a [draft](onboarding-draft.md) whose answers contain the fragment below gets `200 {submitted: true, ...}`, provided the number fits the business country. The same fragment with `vatRegistered: false` gets `400 validation_failed`.
```json
{ "vatRegistered": true, "vatNumber": "DE123456789" }
```
(The VAT number value is illustrative.)

## Known gaps
- The spec does not say which of the four onboarding steps holds `vatNumber`.
- The spec does not say how "fits the business country" is checked. It could be a format check per country or a lookup in an external VAT registry.
- The spec does not say whether the VAT number read from the [`VAT_CERTIFICATE`](onboarding-document-type.md) is compared with `vatNumber`. It also does not say whether such a comparison is what produces [`vat_invalid`](vat-invalid.md) at review.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
