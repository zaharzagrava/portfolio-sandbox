---
id: document-kind
title: Document kind
kind: term
status: draft
aliases: [kind]
defined_for: S04-kyc-onboarding
rules_hash: 7621216a7c1a
---
# Document kind
## Definition
A document kind is the category of a [KYC ↗](../sw-external-terms.md#kyc) document a shop uploads, such as `BUSINESS_REGISTRATION`, `BANK_STATEMENT` or `VAT_CERTIFICATE`. The kind decides whether a document is required for the shop. Answers in the questionnaire, mainly [`vatRegistered`](vat-registered.md), change which kinds are required. Many rules apply per kind: approval, the [per-round document cap](document-round.md), and [superseding](document-supersede.md) older files. The application becomes `VERIFIED` once every required kind has an approved document.

## Example
A shop with `vatRegistered: false` must provide `BUSINESS_REGISTRATION` and `BANK_STATEMENT`. Requesting a `VAT_CERTIFICATE` upload answers `[422 document_not_required](document-not-required.md)`. After the bank statement is approved, a new `BANK_STATEMENT` request answers `409 document_already_approved`.

## Known gaps
- The spec does not say whether any kinds exist beyond the three required ones, or what error an unknown kind name gets.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-08, R-11
- [document-already-approved](document-already-approved.md)
- [document-content-hash](document-content-hash.md)
- [document-deduplicated-flag](document-deduplicated-flag.md)
- [document-not-required](document-not-required.md)
- [onboarding-application-status](onboarding-application-status.md)
- [required-document-kind](required-document-kind.md)
- [required-documents](required-documents.md)
- [required-onboarding-documents](required-onboarding-documents.md)
- [shop-onboarding-document-rejected-event](shop-onboarding-document-rejected-event.md)
- [superseded-document](superseded-document.md)
<!-- used-by:end -->
