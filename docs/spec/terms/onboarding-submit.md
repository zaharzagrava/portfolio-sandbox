---
id: onboarding-submit
title: Onboarding submit
kind: term
status: draft
aliases: [submission, submit]
defined_for: S04-kyc-onboarding
rules_hash: e126fe3049bd
---
# Onboarding submit
## Definition
Onboarding submit turns a complete [questionnaire draft](onboarding-draft.md) into a submitted application. It checks that every [step](onboarding-step.md) is present and that the VAT answers are consistent, and it answers [`400 validation_failed`](validation-failed-error.md) otherwise. On success, the application becomes [`SUBMITTED`](onboarding-application-status.md) and a [`shop.onboarding_submitted` event](shop-onboarding-submitted-event.md) is emitted. The answer lists the [required onboarding documents](required-onboarding-documents.md). Submit is [idempotent ↗](../sw-external-terms.md#idempotency) and [rate-limited](rate-limit.md) per shop. After submission, further step saves answer [`409 already_submitted`](already-submitted.md).

## Example
```json
200 {"submitted": true, "submissionNo": 1, "requiredDocuments": ["BUSINESS_REGISTRATION", "BANK_STATEMENT"]}
```
The [`requiredDocuments`](required-documents.md) value shown is illustrative for a shop that is not [VAT-registered](vat-registered.md). After a [`REJECTED`](onboarding-application-status.md) application, the seller saves a step and submits again, and [`submissionNo`](submission-no.md) becomes 2.

## Known gaps
- The spec does not say how the VAT number is checked against the business country, or which countries are supported.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-03
- [onboarding-draft](onboarding-draft.md)
- [onboarding-questionnaire](onboarding-questionnaire.md)
- [onboarding-row](onboarding-row.md)
- [onboarding-status-history](onboarding-status-history.md)
- [onboarding-step](onboarding-step.md)
- [post-consumption-submit](post-consumption-submit.md)
- [rate-limit](rate-limit.md)
- [rejected-operation](rejected-operation.md)
- [required-document-kind](required-document-kind.md)
- [required-onboarding-documents](required-onboarding-documents.md)
- [shop-onboarding-submitted-event](shop-onboarding-submitted-event.md)
- [submission-no](submission-no.md)
- [vat-invalid](vat-invalid.md)
- [vat-number](vat-number.md)
- [vat-registered](vat-registered.md)
<!-- used-by:end -->
