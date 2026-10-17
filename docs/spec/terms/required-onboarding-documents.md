---
id: required-onboarding-documents
title: Required onboarding documents
kind: term
status: draft
aliases: [required documents]
defined_for: S04-kyc-onboarding
rules_hash: a1b269fb8320
---
# Required onboarding documents
## Definition
The required onboarding documents are the [document kinds](document-kind.md) a shop must have [approved](document-review.md) before it becomes [verified](shop-verification.md). `BUSINESS_REGISTRATION` and `BANK_STATEMENT` are always required. `VAT_CERTIFICATE` is required only when the [questionnaire](onboarding-questionnaire.md) says [`vatRegistered`](vat-registered.md) is true. The list is fixed at submit and returned as `requiredDocuments`. When the last required kind is approved, the application becomes `VERIFIED` and `shop.verified` is emitted.

## Example
A shop answered `vatRegistered: false`. Its required documents are `BUSINESS_REGISTRATION` and `BANK_STATEMENT`. Requesting a `VAT_CERTIFICATE` upload answers `422 document_not_required`.

## Known gaps
- The spec does not say whether the list is recalculated if a resubmission changes the `vatRegistered` answer.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-04
- [already-verified](already-verified.md)
- [onboarding-document-type](onboarding-document-type.md)
- [onboarding-submit](onboarding-submit.md)
<!-- used-by:end -->
