---
id: required-documents
title: requiredDocuments
kind: term
status: draft
aliases: [required documents]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# requiredDocuments
## Definition
`requiredDocuments` lists the [document kinds](document-kind.md) a shop must provide. It is returned when the [onboarding draft](onboarding-draft.md) is submitted. It always contains `BUSINESS_REGISTRATION` and `BANK_STATEMENT`. It contains `VAT_CERTIFICATE` only when [`vatRegistered`](vat-registered.md) is true. The application becomes [`VERIFIED`](onboarding-application-status.md) when every listed kind has an [approved document](document-review.md). Requesting an upload for a kind that is not required answers [`422 document_not_required`](document-not-required.md).

## Example
A VAT-registered shop submits and gets `requiredDocuments` with `BUSINESS_REGISTRATION`, `BANK_STATEMENT` and `VAT_CERTIFICATE`. A shop that is not VAT registered gets only the first two. Its request for a `VAT_CERTIFICATE` upload answers `422 document_not_required`.

## Known gaps
- The spec does not give the exact JSON shape of `requiredDocuments`, for example a plain array of kind names or objects with a status.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
